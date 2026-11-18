const { expect } = require('chai');
const Fastify = require('fastify');
const appRuntime = require('..');

describe('app-ops /app-ops/menus', function () {
  this.timeout(10000);
  let fastify;

  const manifest = { integration: 'iframe', menus: [{ key: 'home', label: '首页', path: '/home' }] };

  const create = async ({ menus, scope = 'app-ops:permissions:read' } = {}) => {
    fastify = Fastify({ logger: false });
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: ':memory:', logging: false }
    });
    fastify.decorate('oidc', {
      options: { runtime: { claims: {} } },
      verifier: {
        verifyAccessToken: async token => {
          if (token !== 'ops') {
            throw new Error('invalid');
          }
          return { sub: 'platform', scope };
        }
      }
    });
    await fastify.register(appRuntime, {
      packageJson: { name: 'demo', version: '1.0.0' },
      static: false,
      appOps: { enabled: true },
      menus
    });
    await fastify.ready();
  };

  const get = headers => fastify.inject({ method: 'GET', url: '/app-ops/menus', headers });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
  });

  it('带 app-ops:permissions:read 的服务令牌可读取 manifest', async () => {
    await create({ menus: { manifest } });
    const res = await get({ authorization: 'Bearer ops' });
    expect(res.statusCode).to.equal(200);
    expect(res.json()).to.deep.equal(manifest);
  });

  it('没有声明菜单返回 404', async () => {
    await create({ menus: { file: '/tmp/no-such-menus-file.json' } });
    const res = await get({ authorization: 'Bearer ops' });
    expect(res.statusCode).to.equal(404);
  });

  it('缺少 scope 返回 403，没有令牌返回 401', async () => {
    await create({ menus: { manifest }, scope: 'app-ops:logs:read' });
    expect((await get({ authorization: 'Bearer ops' })).statusCode).to.equal(403);
    expect((await get({})).statusCode).to.equal(401);
  });
});
