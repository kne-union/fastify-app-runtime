const { expect } = require('chai');
const Fastify = require('fastify');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appRuntime = require('..');
const { createFileStore, createPlatformDbStore } = require('../libs/app-ops/store');

const makeTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'app-ops-store-'));

describe('app-ops 文件存储容量上限', function () {
  let dir;
  beforeEach(() => {
    dir = makeTmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('访问日志超过上限时淘汰最早的，保留最近的', async () => {
    const store = createFileStore({ rootDir: dir, limits: { accessLogs: 3 } });
    for (let i = 1; i <= 5; i++) {
      await store.appendAccessLog({ action: `a${i}` });
    }
    const { pageData, totalCount } = await store.listAccessLogs();
    expect(totalCount).to.equal(3);
    expect(pageData.map(r => r.action)).to.deep.equal(['a5', 'a4', 'a3']);
  });

  it('已用 jti 超过上限时淘汰最早过期的', async () => {
    const store = createFileStore({ rootDir: dir, limits: { usedJtis: 2 } });
    await store.addJti('j1', 60 * 1000);
    await store.addJti('j2', 120 * 1000);
    await store.addJti('j3', 180 * 1000);
    expect(await store.hasJti('j1')).to.equal(false);
    expect(await store.hasJti('j2')).to.equal(true);
    expect(await store.hasJti('j3')).to.equal(true);
  });

  it('写入 jti 时顺带清掉已过期的，不依赖被查询才清理', async () => {
    const store = createFileStore({ rootDir: dir });
    await store.addJti('old', -1000);
    await store.addJti('fresh', 60 * 1000);
    const saved = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    expect(Object.keys(saved.usedJtis)).to.deep.equal(['fresh']);
  });

  it('兑换失败计数超过上限时优先淘汰未锁定且最久未更新的，保留已锁定的', async () => {
    const store = createFileStore({ rootDir: dir, limits: { redeemFailures: 2 } });
    for (let i = 0; i < 5; i++) {
      await store.bumpRedeemFailure('locked');
    }
    await store.bumpRedeemFailure('a');
    await store.bumpRedeemFailure('b');
    expect((await store.getRedeemFailure('locked')).lockedUntil).to.be.greaterThan(Date.now());
    expect((await store.getRedeemFailure('a')).count).to.equal(0);
    expect((await store.getRedeemFailure('b')).count).to.equal(1);
  });

  it('未锁定且超过保留时长未更新的失败计数会被清理', async () => {
    const store = createFileStore({ rootDir: dir, limits: { redeemFailureTtlMs: 1000 } });
    await store.bumpRedeemFailure('stale');
    const saved = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    saved.redeemFailures.stale.updatedAt = Date.now() - 5000;
    fs.writeFileSync(store.filePath, JSON.stringify(saved));
    const reloaded = createFileStore({ rootDir: dir, limits: { redeemFailureTtlMs: 1000 } });
    expect((await reloaded.getRedeemFailure('stale')).count).to.equal(0);
  });

  it('旧版本留下的超限文件在加载时按上限收敛', async () => {
    const accessLogs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), action: `a${i}` }));
    const usedJtis = {};
    for (let i = 0; i < 10; i++) {
      usedJtis[`j${i}`] = Date.now() + (i + 1) * 60 * 1000;
    }
    fs.writeFileSync(path.join(dir, 'app-ops-platforms.json'), JSON.stringify({ platforms: [], accessLogs, usedJtis, redeemFailures: {} }));
    const store = createFileStore({ rootDir: dir, limits: { accessLogs: 4, usedJtis: 4 } });
    expect((await store.listAccessLogs()).totalCount).to.equal(4);
    expect(await store.hasJti('j0')).to.equal(false);
    expect(await store.hasJti('j9')).to.equal(true);
  });
});

describe('app-ops 平台登记存数据库', function () {
  this.timeout(10000);
  let tmp;
  let fastify;

  const origin = 'https://platform.example.com';

  const create = async ({ dataDir, appOps = {} } = {}) => {
    fastify = Fastify({ logger: false });
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(tmp, 'app.db'), logging: false }
    });
    // 本地管理员鉴权：登记/解除/列表接口需要
    fastify.decorate('account', {
      authenticate: {
        user: async request => {
          request.userInfo = { id: 'admin-1', isSuperAdmin: true };
        },
        admin: async () => {}
      }
    });
    await fastify.register(appRuntime, {
      packageJson: { name: 'demo', version: '1.0.0' },
      static: false,
      appOps: Object.assign({ enabled: true, dataDir: dataDir || path.join(tmp, 'data-v1') }, appOps)
    });
    await fastify.sequelize.sync();
    await fastify.ready();
  };

  const closeApp = async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
  };

  const platformModel = () => fastify.sequelize.instance.models.appOpsPlatform;

  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(async () => {
    await closeApp();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const dbStore = () => createPlatformDbStore({ model: platformModel() });

  it('登记写入数据库，换一个全新的 data 目录（模拟部署新版本）后仍然存在', async () => {
    await create({ dataDir: path.join(tmp, 'data-v1') });
    await dbStore().upsertPlatform({ platformOrigin: origin, platformName: '主平台', installId: 'install-1', status: 'paired' });
    await closeApp();

    await create({ dataDir: path.join(tmp, 'data-v2') });
    const rows = await dbStore().getPlatforms();
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ platformOrigin: origin, platformName: '主平台', status: 'paired' });
    expect(await dbStore().findPlatformByInstallId('install-1')).to.have.property('platformOrigin', origin);
  });

  it('通过登记接口写入的平台，换新 data 目录重启后仍能列出，解除后消失', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ issuer: origin, jwks_uri: `${origin}/oidc/jwks` }) });
    try {
      await create({ dataDir: path.join(tmp, 'data-v1') });
      const registered = await fastify.inject({ method: 'POST', url: '/app-ops/link/register', payload: { platformOrigin: origin, platformName: '主平台' } });
      expect(registered.statusCode).to.equal(200);
      await closeApp();

      await create({ dataDir: path.join(tmp, 'data-v2') });
      const listed = await fastify.inject({ method: 'GET', url: '/app-ops/link/platforms' });
      expect(listed.json().data.pageData.map(p => p.platformOrigin)).to.deep.equal([origin]);

      const unlinked = await fastify.inject({ method: 'POST', url: '/app-ops/link/unlink', payload: { platformOrigin: origin } });
      expect(unlinked.statusCode).to.equal(200);
      const after = await fastify.inject({ method: 'GET', url: '/app-ops/link/platforms' });
      expect(after.json().data.pageData).to.have.length(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('upsert 按规范化地址合并同一平台，不新增重复行', async () => {
    await create();
    const store = dbStore();
    await store.upsertPlatform({ platformOrigin: origin, platformName: 'A', installId: 'i1', status: 'issued' });
    const merged = await store.upsertPlatform({ platformOrigin: `${origin.toUpperCase()}/`, status: 'paired' });
    expect(merged).to.include({ platformName: 'A', status: 'paired', installId: 'i1' });
    expect(await store.getPlatforms()).to.have.length(1);
    expect(await store.findPlatformByOrigin(`${origin}/`)).to.have.property('status', 'paired');
  });

  it('删除后可以重新登记同一平台', async () => {
    await create();
    const store = dbStore();
    await store.upsertPlatform({ platformOrigin: origin, installId: 'i1' });
    expect(await store.removePlatform(origin)).to.equal(true);
    expect(await store.removePlatform(origin)).to.equal(false);
    await store.upsertPlatform({ platformOrigin: origin, installId: 'i2' });
    expect(await store.findPlatformByInstallId('i2')).to.have.property('platformOrigin', origin);
  });

  it('重启后把数据库里已配对的平台灌回 oidc.platforms，未配对的不灌', async () => {
    await create({ dataDir: path.join(tmp, 'data-hydrate') });
    await dbStore().upsertPlatform({
      platformOrigin: origin,
      platformName: '已配对',
      installId: 'i1',
      status: 'paired',
      issuer: origin,
      jwksUri: `${origin}/oidc/jwks`,
      oidc: { clientId: 'c1', serviceClientId: 's1', serviceClientSecret: 'secret', appCode: 'demo' }
    });
    await dbStore().upsertPlatform({ platformOrigin: 'https://pending.example.com', installId: 'i2', status: 'issued' });
    await closeApp();

    const upserted = [];
    fastify = Fastify({ logger: false });
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(tmp, 'app.db'), logging: false }
    });
    fastify.decorate('oidc', { platforms: { upsert: row => upserted.push(row) } });
    await fastify.register(appRuntime, {
      packageJson: { name: 'demo', version: '1.0.0' },
      static: false,
      appOps: { enabled: true, dataDir: path.join(tmp, 'data-hydrate-2') }
    });
    await fastify.sequelize.sync();
    await fastify.ready();
    expect(upserted.map(p => p.platformOrigin)).to.deep.equal([origin]);
    expect(upserted[0]).to.include({ status: 'paired', spaClientId: 'c1', serviceClientId: 's1', serviceClientSecret: 'secret', appCode: 'demo' });
  });

  it('platformStore 为 file 时不登记模型，继续用文件存储', async () => {
    await create({ appOps: { platformStore: 'file' } });
    expect(platformModel()).to.equal(undefined);
  });
});
