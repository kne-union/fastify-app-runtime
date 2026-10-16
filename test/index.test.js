const { expect } = require('chai');
const Fastify = require('fastify');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appRuntime = require('..');
const { getRemoteModuleConfigFile, resolveConfigUrl } = require('../libs/utils');

const createBuildDir = files => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-runtime-build-'));
  Object.keys(files).forEach(name => {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof files[name] === 'string' ? files[name] : JSON.stringify(files[name]));
  });
  return dir;
};

const createApp = async ({ options = {}, config, beforeRegister } = {}) => {
  const fastify = Fastify({ logger: false });
  if (config) {
    fastify.decorate('config', config);
  }
  await fastify.register(require('@kne/fastify-sequelize'), {
    db: { dialect: 'sqlite', storage: ':memory:', logging: false }
  });
  if (beforeRegister) {
    beforeRegister(fastify);
  }
  await fastify.register(appRuntime, Object.assign({ packageJson: { name: '@kne/demo-app', version: '1.2.3' } }, options));
  await fastify.ready();
  await fastify.sequelize.sync();
  return fastify;
};

describe('@kne/fastify-app-runtime', function () {
  this.timeout(10000);
  let fastify;

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
  });

  describe('插件注册测试', () => {
    it('should decorate namespace and register fastify-setting with default options', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}) } });
      expect(fastify.appRuntime.services.getRemoteModuleConfig).to.be.a('function');
      expect(fastify.setting.services.detail).to.be.a('function');
    });

    it('should fail to register when fastify-sequelize is not registered', async () => {
      const app = Fastify({ logger: false });
      app.register(appRuntime, { root: createBuildDir({}) });
      let error;
      try {
        await app.ready();
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.message).to.contain('fastify-sequelize');
      await app.close().catch(() => {});
    });

    it('should start when build directory does not exist', async () => {
      fastify = await createApp({ options: { root: path.join(os.tmpdir(), 'app-runtime-not-exists-' + Date.now()) } });
      const health = await fastify.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).to.equal(200);
      const config = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(config.statusCode).to.equal(404);
      const page = await fastify.inject({ method: 'GET', url: '/' });
      expect(page.statusCode).to.equal(404);
    });
  });

  describe('remote-module-config.json', () => {
    it('should complete relative url with origin and set CORS header', async () => {
      const root = createBuildDir({ 'remote-module-config.json': { name: 'demo', url: 'static', tpl: '{{url}}', version: '1_2_3' } });
      fastify = await createApp({ options: { root, origin: 'https://demo.example.com/' } });
      const res = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(res.statusCode).to.equal(200);
      expect(res.headers['access-control-allow-origin']).to.equal('*');
      expect(res.json()).to.deep.equal({ name: 'demo', url: 'https://demo.example.com/static', tpl: '{{url}}', version: '1_2_3' });
    });

    it('should keep absolute url and fall back to origin when url is empty', async () => {
      expect(resolveConfigUrl('https://cdn.example.com/app/abc', 'https://demo.example.com')).to.equal('https://cdn.example.com/app/abc');
      expect(resolveConfigUrl('', 'https://demo.example.com')).to.equal('https://demo.example.com');
      expect(resolveConfigUrl('/static/', 'https://demo.example.com')).to.equal('https://demo.example.com/static/');
    });

    it('should pick config file by entry of current env from fastify.config', async () => {
      const root = createBuildDir({
        'remote-module-config.json': { url: 'https://cdn.example.com/local' },
        'remote-module-config-prod.json': { url: 'https://cdn.example.com/prod' }
      });
      fastify = await createApp({ options: { root }, config: { ENV: 'prod', ORIGIN: 'https://demo.example.com' } });
      const res = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(res.json().url).to.equal('https://cdn.example.com/prod');
    });

    it('should follow custom getEntry for landscape specific entries', async () => {
      const root = createBuildDir({ 'remote-module-config-cn-staging.json': { url: 'https://cdn.example.com/cn-staging' } });
      fastify = await createApp({
        options: {
          root,
          getEntry: ({ env, config }) => (env !== 'local' ? `entry-${config.LANDSCAPE}-${env}.html` : 'index.html')
        },
        config: { ENV: 'staging', LANDSCAPE: 'cn' }
      });
      const res = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(res.statusCode).to.equal(200);
      expect(res.json().url).to.equal('https://cdn.example.com/cn-staging');
    });

    it('should map entry file to config file the same way as npm-tools entryHtml', () => {
      expect(getRemoteModuleConfigFile('index.html')).to.equal('remote-module-config.json');
      expect(getRemoteModuleConfigFile('entry.html')).to.equal('remote-module-config.json');
      expect(getRemoteModuleConfigFile('entry-prod.html')).to.equal('remote-module-config-prod.json');
      expect(getRemoteModuleConfigFile('entry-cn-prod.html')).to.equal('remote-module-config-cn-prod.json');
      expect(getRemoteModuleConfigFile('main.html')).to.equal('remote-module-config-main.json');
    });

    it('should not be wrapped by host onSend envelope hooks', async () => {
      const root = createBuildDir({ 'remote-module-config.json': { url: 'https://cdn.example.com/a' } });
      fastify = await createApp({
        options: { root },
        beforeRegister: app => {
          app.addHook('onSend', async (request, reply, payload) => {
            const contentType = String(reply.getHeader('content-type') || '');
            if (typeof payload === 'string' && contentType.includes('application/json')) {
              return JSON.stringify({ code: 0, data: JSON.parse(payload) });
            }
            return payload;
          });
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(res.json()).to.deep.equal({ url: 'https://cdn.example.com/a' });
    });

    it('should respond 500 when config file is not valid JSON', async () => {
      const root = createBuildDir({ 'remote-module-config.json': '{invalid' });
      fastify = await createApp({ options: { root } });
      const res = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(res.statusCode).to.equal(500);
    });

    it('should not set CORS header when cors is false', async () => {
      const root = createBuildDir({ 'remote-module-config.json': { url: 'https://cdn.example.com/a' } });
      fastify = await createApp({ options: { root, cors: false } });
      const res = await fastify.inject({ method: 'GET', url: '/remote-module-config.json' });
      expect(res.headers['access-control-allow-origin']).to.be.undefined;
    });
  });

  describe('健康检查测试', () => {
    it('should return liveness with package name and version', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}) } });
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      const data = res.json();
      expect(res.statusCode).to.equal(200);
      expect(data.status).to.equal('ok');
      expect(data.name).to.equal('@kne/demo-app');
      expect(data.version).to.equal('1.2.3');
      expect(data.uptime).to.be.a('number');
    });

    it('should be ready when database is reachable', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}) } });
      const res = await fastify.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).to.equal(200);
      expect(res.json()).to.deep.equal({ status: 'ok', checks: { database: 'ok' } });
    });

    it('should return 503 when a custom check fails or times out without leaking error detail', async () => {
      fastify = await createApp({
        options: {
          root: createBuildDir({}),
          timeout: 50,
          readyChecks: {
            redis: async () => {
              throw new Error('connect ECONNREFUSED 10.0.0.1:6379');
            },
            slow: () => new Promise(resolve => setTimeout(resolve, 500))
          }
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).to.equal(503);
      expect(res.json()).to.deep.equal({ status: 'error', checks: { database: 'ok', redis: 'error', slow: 'timeout' } });
    });
  });

  describe('应用设置测试', () => {
    it('should return runtime info and enabled settings', async () => {
      fastify = await createApp({
        options: {
          root: createBuildDir({}),
          origin: 'https://demo.example.com',
          runtime: { landscape: 'cn' },
          setting: { setting: { systemType: 'saas' } }
        },
        config: { ENV: 'staging' }
      });
      await fastify.setting.services.saveOrCreate({ settingKey: 'siteTitle', settingValue: { zh: '演示系统' } });
      const res = await fastify.inject({ method: 'GET', url: '/app-config.json' });
      expect(res.statusCode).to.equal(200);
      expect(res.headers['access-control-allow-origin']).to.equal('*');
      expect(res.json()).to.deep.equal({
        runtime: { name: '@kne/demo-app', version: '1.2.3', env: 'staging', origin: 'https://demo.example.com', landscape: 'cn' },
        settings: { siteTitle: { zh: '演示系统' }, systemType: 'saas' }
      });
    });

    it('should keep fastify-setting routes under custom prefix', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}), setting: { prefix: '/api/v1/setting', getAuthenticate: () => [] } } });
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/setting/detail' });
      expect(res.statusCode).to.equal(200);
    });

    it('should return settings as null when loading settings fails', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}) } });
      fastify.setting.services.detail = async () => {
        throw new Error('db down');
      };
      const res = await fastify.inject({ method: 'GET', url: '/app-config.json' });
      expect(res.statusCode).to.equal(200);
      expect(res.json().settings).to.equal(null);
      expect(res.json().runtime.env).to.equal('local');
    });
  });

  describe('OpenAPI 文档测试', () => {
    const mockAccount = app => {
      app.decorate('account', {
        authenticate: {
          user: async request => {
            request.userInfo = { id: 'u1' };
          },
          admin: async request => {
            if (request.headers['x-admin'] !== '1') {
              throw Object.assign(new Error('不能执行该操作，需要超级管理员权限'), { statusCode: 401 });
            }
          }
        }
      });
    };

    const registerSwagger = app => {
      app.register(require('@fastify/swagger'), { openapi: { info: { title: 'demo', version: '1.2.3' } } });
      app.register(async instance => {
        instance.get('/api/biz', { schema: { summary: '业务接口' } }, async () => ({ ok: true }));
      });
    };

    it('should return open-api document for admin', async () => {
      fastify = await createApp({
        options: { root: createBuildDir({}) },
        beforeRegister: app => {
          registerSwagger(app);
          mockAccount(app);
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { 'x-admin': '1' } });
      expect(res.statusCode).to.equal(200);
      const data = res.json();
      expect(data.openapi).to.be.a('string');
      expect(data.info.title).to.equal('demo');
      expect(data.paths).to.have.property('/api/biz');
      expect(data.paths).to.have.property('/health');
    });

    it('should reject non admin user', async () => {
      fastify = await createApp({
        options: { root: createBuildDir({}) },
        beforeRegister: app => {
          registerSwagger(app);
          mockAccount(app);
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/open-api.json' });
      expect(res.statusCode).to.equal(401);
    });

    it('should not register route when host has no account module', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}), static: false }, beforeRegister: registerSwagger });
      const res = await fastify.inject({ method: 'GET', url: '/open-api.json' });
      expect(res.statusCode).to.equal(404);
    });

    it('should not register route when @fastify/swagger is not registered', async () => {
      fastify = await createApp({ options: { root: createBuildDir({}), static: false }, beforeRegister: mockAccount });
      const res = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { 'x-admin': '1' } });
      expect(res.statusCode).to.equal(404);
    });

    it('should not register route when openApi is false', async () => {
      fastify = await createApp({
        options: { root: createBuildDir({}), static: false, openApi: false },
        beforeRegister: app => {
          registerSwagger(app);
          mockAccount(app);
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { 'x-admin': '1' } });
      expect(res.statusCode).to.equal(404);
    });

    describe('OIDC 服务令牌', () => {
      const clientTokenClaim = 'https://idp.example.com/client_token';
      const tokens = {
        service: { [clientTokenClaim]: true, scope: 'open-api:read' },
        'service-no-scope': { [clientTokenClaim]: true, scope: 'user:read' },
        user: { sub: 'u1', scope: 'open-api:read' }
      };
      const mockOidc = app => {
        app.decorate('oidc', {
          options: { runtime: { claims: { clientToken: clientTokenClaim } } },
          verifier: {
            verifyAccessToken: async token => {
              if (!tokens[token]) {
                throw new Error('invalid token');
              }
              return tokens[token];
            }
          }
        });
      };
      const createOidcApp = () =>
        createApp({
          options: { root: createBuildDir({}), static: false },
          beforeRegister: app => {
            registerSwagger(app);
            mockAccount(app);
            mockOidc(app);
          }
        });

      it('should accept client token with open-api:read scope without admin', async () => {
        fastify = await createOidcApp();
        const res = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { authorization: 'Bearer service' } });
        expect(res.statusCode).to.equal(200);
        expect(res.json().paths).to.have.property('/api/biz');
      });

      it('should fall back to admin check for client token without scope, user token or invalid token', async () => {
        fastify = await createOidcApp();
        for (const token of ['service-no-scope', 'user', 'invalid']) {
          const res = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { authorization: `Bearer ${token}` } });
          expect(res.statusCode, token).to.equal(401);
        }
        const admin = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { authorization: 'Bearer user', 'x-admin': '1' } });
        expect(admin.statusCode).to.equal(200);
      });
    });

    it('should use custom path', async () => {
      fastify = await createApp({
        options: { root: createBuildDir({}), static: false, openApi: { path: '/api/v1/open-api.json' } },
        beforeRegister: app => {
          registerSwagger(app);
          mockAccount(app);
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/open-api.json', headers: { 'x-admin': '1' } });
      expect(res.statusCode).to.equal(200);
      expect(res.json().paths).to.have.property('/api/biz');
      const old = await fastify.inject({ method: 'GET', url: '/open-api.json', headers: { 'x-admin': '1' } });
      expect(old.statusCode).to.equal(404);
    });
  });

  describe('前端托管测试', () => {
    const files = {
      'index.html': '<html>local</html>',
      'entry-prod.html': '<html>prod</html>',
      'static/js/main.js': 'console.log(1);'
    };

    it('should serve entry html, static files and SPA fallback', async () => {
      fastify = await createApp({ options: { root: createBuildDir(files) } });
      const index = await fastify.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).to.equal(200);
      expect(index.body).to.equal('<html>local</html>');
      const asset = await fastify.inject({ method: 'GET', url: '/static/js/main.js' });
      expect(asset.body).to.equal('console.log(1);');
      const route = await fastify.inject({ method: 'GET', url: '/jobs/detail?id=1' });
      expect(route.statusCode).to.equal(200);
      expect(route.headers['content-type']).to.contain('text/html');
      expect(route.body).to.equal('<html>local</html>');
      const post = await fastify.inject({ method: 'POST', url: '/not-exists' });
      expect(post.statusCode).to.equal(404);
    });

    it('should use entry of current env', async () => {
      fastify = await createApp({ options: { root: createBuildDir(files), env: 'prod' } });
      const index = await fastify.inject({ method: 'GET', url: '/' });
      expect(index.body).to.equal('<html>prod</html>');
      const route = await fastify.inject({ method: 'GET', url: '/any/page' });
      expect(route.body).to.equal('<html>prod</html>');
    });

    it('should not serve frontend when static is false', async () => {
      fastify = await createApp({ options: { root: createBuildDir(files), static: false } });
      const index = await fastify.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).to.equal(404);
      const health = await fastify.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).to.equal(200);
    });

    it('should not register not found handler when fallback is false', async () => {
      fastify = await createApp({
        options: { root: createBuildDir(files), static: { prefix: '/', fallback: false } },
        beforeRegister: app => {
          app.setNotFoundHandler((request, reply) => reply.code(404).send({ custom: true }));
        }
      });
      const res = await fastify.inject({ method: 'GET', url: '/any/page' });
      expect(res.json()).to.deep.equal({ custom: true });
    });
  });
});
