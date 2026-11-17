const fp = require('fastify-plugin');
const path = require('node:path');
const { sendJson } = require('../utils');
const { isAppOpsEnabled } = require('./enabled');
const { createFileStore } = require('./store');
const { requireOpsScope, requireLocalAdmin } = require('./auth');
const { createLogsRuntime } = require('./logs');
const { getEnvDeclaration } = require('./env');
const db = require('./db');
const migrations = require('./migrations');
const { createLinkService } = require('./link');
const { getPermissions } = require('./permissions');

const sendError = (reply, err, cors) => {
  const statusCode = err.statusCode || 500;
  return sendJson(reply, {
    statusCode,
    data: { message: err.message || 'error' },
    cors
  });
};

const meta = request => ({
  ip: request.ip,
  userAgent: request.headers['user-agent']
});

/**
 * 仅当 APP_OPS_ENABLED（或 options.appOps.enabled）为真时注册。
 * 关闭时本模块不会被加载，/app-ops/* 不存在。
 */
module.exports = fp(async (fastify, options) => {
  const cors = options.cors;
  const config = fastify.config || {};
  if (!isAppOpsEnabled(options, config)) {
    fastify.log.info('app-runtime: APP_OPS_ENABLED 未开启，跳过远程管理 /app-ops');
    return;
  }

  const store = createFileStore({
    rootDir: options.appOps?.dataDir || path.resolve(process.cwd(), './data'),
    fileName: options.appOps?.storeFile
  });
  const logs = createLogsRuntime(fastify, options);
  await logs.start();
  fastify.addHook('onClose', async () => logs.stop());

  const link = createLinkService({ store, options, fastify });
  const audit = async entry => store.appendAccessLog(entry);

  const withOps = (scope, handler) => async (request, reply) => {
    try {
      const payload = await requireOpsScope(fastify, request, scope);
      const data = await handler(request, reply, payload);
      if (reply.sent) {
        return;
      }
      return sendJson(reply, { data, cors });
    } catch (err) {
      await audit({
        action: scope,
        result: 'error',
        statusCode: err.statusCode || 500,
        detail: err.message,
        ip: request.ip,
        userAgent: request.headers['user-agent']
      }).catch(() => {});
      return sendError(reply, err, cors);
    }
  };

  // —— 平台登记（本地管理员）——
  fastify.get('/app-ops/link/platforms', async (request, reply) => {
    try {
      await requireLocalAdmin(fastify, request);
      return sendJson(reply, { data: { pageData: await link.listPlatforms() }, cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  fastify.post('/app-ops/link/register', async (request, reply) => {
    try {
      await requireLocalAdmin(fastify, request);
      const data = await link.register(request.body || {});
      await audit({ action: 'register', result: 'ok', statusCode: 200, platformOrigin: data.platformOrigin, ip: request.ip });
      return sendJson(reply, { data, cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  fastify.post('/app-ops/link/redeem', async (request, reply) => {
    try {
      const data = await link.redeem(request.body || {}, meta(request));
      return sendJson(reply, { data, cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  fastify.post('/app-ops/link/activate', async (request, reply) => {
    try {
      const data = await link.activate(request.body || {}, meta(request));
      return sendJson(reply, { data, cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  fastify.get('/app-ops/link/status', async (request, reply) => {
    try {
      await requireOpsScope(fastify, request, 'app-ops:permissions:read').catch(() => requireOpsScope(fastify, request, 'open-api:read'));
      return sendJson(reply, { data: await link.status({ issuer: request.query?.issuer }), cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  fastify.post('/app-ops/link/unlink', async (request, reply) => {
    try {
      await requireLocalAdmin(fastify, request);
      return sendJson(reply, { data: await link.unlink(request.body?.platformOrigin), cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  fastify.get('/app-ops/link/access-logs', async (request, reply) => {
    try {
      await requireLocalAdmin(fastify, request);
      const data = await store.listAccessLogs({
        platformOrigin: request.query?.platformOrigin,
        action: request.query?.action,
        limit: Number(request.query?.limit) || 50,
        offset: Number(request.query?.offset) || 0
      });
      return sendJson(reply, { data, cors });
    } catch (err) {
      return sendError(reply, err, cors);
    }
  });

  // —— 权限 ——
  fastify.get(
    '/app-ops/permissions',
    withOps('app-ops:permissions:read', async () => {
      const permissions = await getPermissions(fastify, options);
      return { permissions };
    })
  );

  // —— 日志 ——
  fastify.get(
    '/app-ops/logs',
    withOps('app-ops:logs:read', async request => {
      await audit({ action: 'logs', result: 'ok', statusCode: 200, ip: request.ip });
      return logs.read(request.query || {});
    })
  );
  fastify.get(
    '/app-ops/logs/files',
    withOps('app-ops:logs:read', async () => logs.files())
  );

  // —— 环境变量只读 ——
  fastify.get(
    '/app-ops/env',
    withOps('app-ops:env:read', async () => getEnvDeclaration(fastify, options))
  );

  // —— 数据运维 ——
  fastify.get(
    '/app-ops/db/tables',
    withOps('app-ops:db:read', async () => db.listTables(fastify, options))
  );
  fastify.get(
    '/app-ops/db/rows',
    withOps('app-ops:db:read', async request => db.listRows(fastify, options, request.query || {}))
  );
  fastify.post(
    '/app-ops/db/query',
    withOps('app-ops:db:read', async request => {
      await audit({ action: 'db.query', result: 'ok', statusCode: 200, ip: request.ip });
      return db.runQuery(fastify, options, request.body || {});
    })
  );
  fastify.post(
    '/app-ops/db/row/save',
    withOps('app-ops:db:write', async request => {
      await audit({ action: 'db.write', result: 'ok', statusCode: 200, detail: request.body?.table, ip: request.ip });
      return db.saveRow(fastify, options, request.body || {});
    })
  );
  fastify.post(
    '/app-ops/db/row/remove',
    withOps('app-ops:db:write', async request => {
      await audit({ action: 'db.write', result: 'ok', statusCode: 200, detail: `remove:${request.body?.table}`, ip: request.ip });
      return db.removeRow(fastify, options, request.body || {});
    })
  );

  // —— 迁移（无版本包）——
  fastify.get(
    '/app-ops/migrations/list',
    withOps('app-ops:migrations:read', async () => migrations.listMigrations(fastify, options))
  );
  fastify.get(
    '/app-ops/migrations/content',
    withOps('app-ops:migrations:read', async request => migrations.readMigrationContent(fastify, options, request.query?.file))
  );
  fastify.post(
    '/app-ops/migrations/action',
    withOps('app-ops:migrations:execute', async request => {
      await audit({
        action: `migrations.${request.body?.action}`,
        result: 'ok',
        statusCode: 200,
        detail: request.body?.file,
        ip: request.ip
      });
      return migrations.runAction(fastify, options, request.body || {});
    })
  );

  fastify.log.info('app-runtime: APP_OPS_ENABLED 已开启，/app-ops 远程管理可用');
});
