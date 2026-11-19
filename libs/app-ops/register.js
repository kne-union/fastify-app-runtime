const fp = require('fastify-plugin');
const path = require('node:path');
const { sendJson } = require('../utils');
const { isAppOpsEnabled } = require('./enabled');
const { createFileStore, createPlatformDbStore } = require('./store');
const { requireOpsScope, requireLocalAdmin } = require('./auth');
const { createLogsRuntime } = require('./logs');
const { getEnvDeclaration } = require('./env');
const db = require('./db');
const migrations = require('./migrations');
const { createLinkService } = require('./link');
const { getPermissions } = require('./permissions');
const { createRateLimiter, clientKeyFromRequest } = require('./rate-limit');

const sendError = (reply, err, cors) => {
  const statusCode = err.statusCode || 500;
  return sendJson(reply, {
    statusCode,
    data: { message: err.message || 'error' },
    cors
  });
};

/** 给 PlatformLink 等业务 ajax（期望 { code, data }）用的成功响应 */
const sendBizOk = (reply, data, cors) => sendJson(reply, { data: { code: 0, data }, cors });

/** 本地管理员接口：失败也回 { code, msg }，HTTP 仍用业务码，便于前端 TablePage 展示而非整页空白 */
const sendBizError = (reply, err, cors) => {
  const statusCode = err.statusCode || 500;
  return sendJson(reply, {
    statusCode,
    data: { code: statusCode, msg: err.message || 'error', message: err.message || 'error' },
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

  const fileStore = createFileStore({
    rootDir: options.appOps?.dataDir || path.resolve(process.cwd(), './data'),
    fileName: options.appOps?.storeFile
  });
  // 平台登记存宿主数据库：文件在版本目录里，部署新版本后会丢。模型须在宿主 sequelize.sync() 之前登记。
  const platformModel = options.appOps?.platformStore === 'file' ? null : (await fastify.sequelize.addModels(require('./platform-model'))).appOpsPlatform;
  const platformDbStore = platformModel ? createPlatformDbStore({ model: platformModel }) : null;
  const store = platformDbStore ? Object.assign(fileStore, platformDbStore) : fileStore;

  // 宿主 sync() 之后表才存在，所以放到 onReady：进程重启后把已配对主平台灌回内存中的 oidc.platforms，否则运维令牌按 iss 验签会失败
  fastify.addHook('onReady', async () => {
    if (fastify.oidc?.platforms?.upsert) {
      try {
        const paired = (await store.getPlatforms()).filter(p => p.status === 'paired');
        for (const p of paired) {
          fastify.oidc.platforms.upsert({
            platformOrigin: p.platformOrigin,
            platformName: p.platformName,
            issuer: p.issuer || p.oidc?.issuer,
            audience: p.audience || p.oidc?.audience,
            spaClientId: p.spaClientId || p.oidc?.clientId,
            serviceClientId: p.serviceClientId || p.oidc?.serviceClientId,
            serviceClientSecret: p.oidc?.serviceClientSecret || (p.serviceClientSecretEnc ? Buffer.from(p.serviceClientSecretEnc, 'base64').toString() : null),
            appCode: p.oidc?.appCode,
            jwksUri: p.jwksUri,
            status: 'paired',
            pairedAt: p.pairedAt
          });
        }
        if (paired.length) {
          fastify.log.info({ count: paired.length }, 'app-ops: hydrated oidc.platforms from paired store');
        }
      } catch (err) {
        fastify.log.warn({ err }, 'app-ops: hydrate oidc.platforms failed');
      }
    }
  });
  const logs = createLogsRuntime(fastify, options);
  await logs.start();
  fastify.addHook('onClose', async () => logs.stop());

  const link = createLinkService({ store, options, fastify });
  const audit = async entry => store.appendAccessLog(entry);
  const limiter = createRateLimiter({
    windowMs: Number(options.appOps?.rateLimitWindowMs || config.APP_OPS_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(options.appOps?.rateLimitMax || config.APP_OPS_RATE_LIMIT_MAX || 60)
  });
  const redeemLimiter = createRateLimiter({
    windowMs: Number(options.appOps?.redeemRateLimitWindowMs || 15 * 60 * 1000),
    max: Number(options.appOps?.redeemRateLimitMax || 20)
  });

  /** 从运维令牌还原主平台地址（iss / client_id → 已登记 platforms） */
  const resolvePlatformOrigin = async payload => {
    if (!payload) {
      return null;
    }
    const platforms = await store.getPlatforms();
    const norm = value =>
      String(value || '')
        .replace(/\/+$/, '')
        .toLowerCase();
    const iss = norm(payload.iss);
    if (iss) {
      const byIssuer = platforms.find(p => norm(p.issuer || p.oidc?.issuer) === iss);
      if (byIssuer?.platformOrigin) {
        return byIssuer.platformOrigin;
      }
    }
    const clientId = String(payload.client_id || payload.clientId || '');
    if (clientId) {
      const byClient = platforms.find(p => p.serviceClientId === clientId || p.oidc?.serviceClientId === clientId || p.spaClientId === clientId);
      if (byClient?.platformOrigin) {
        return byClient.platformOrigin;
      }
    }
    return null;
  };

  const auditOps = async (request, payload, entry = {}) => {
    const platformOrigin = entry.platformOrigin !== undefined ? entry.platformOrigin : await resolvePlatformOrigin(payload);
    return audit(
      Object.assign(
        {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          actor: payload?.sub || payload?.client_id || null,
          issuer: payload?.iss || null
        },
        entry,
        { platformOrigin }
      )
    );
  };

  const withOps = (scope, handler) => async (request, reply) => {
    let payload;
    try {
      payload = await requireOpsScope(fastify, request, scope);
      limiter.check(clientKeyFromRequest(request, payload));
      const data = await handler(request, reply, payload);
      if (reply.sent) {
        return;
      }
      return sendJson(reply, { data, cors });
    } catch (err) {
      await auditOps(request, payload, {
        action: scope,
        result: 'error',
        statusCode: err.statusCode || 500,
        detail: err.message
      }).catch(() => {});
      return sendError(reply, err, cors);
    }
  };

  // —— 平台登记（本地管理员，响应形对齐业务 ajax：{ code, data }）——
  fastify.get('/app-ops/link/platforms', async (request, reply) => {
    try {
      await requireLocalAdmin(fastify, request);
      const pageData = await link.listPlatforms();
      return sendBizOk(reply, { pageData, totalCount: pageData.length }, cors);
    } catch (err) {
      return sendBizError(reply, err, cors);
    }
  });

  fastify.post('/app-ops/link/register', async (request, reply) => {
    try {
      await requireLocalAdmin(fastify, request);
      const data = await link.register(request.body || {});
      await audit({ action: 'register', result: 'ok', statusCode: 200, platformOrigin: data.platformOrigin, ip: request.ip });
      return sendBizOk(reply, data, cors);
    } catch (err) {
      return sendBizError(reply, err, cors);
    }
  });

  fastify.post('/app-ops/link/redeem', async (request, reply) => {
    try {
      redeemLimiter.check(`redeem:${request.ip || 'unknown'}:${(request.body || {}).installId || ''}`);
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
      return sendBizOk(reply, await link.unlink(request.body?.platformOrigin), cors);
    } catch (err) {
      return sendBizError(reply, err, cors);
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
      return sendBizOk(reply, data, cors);
    } catch (err) {
      return sendBizError(reply, err, cors);
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

  // —— 菜单（linked 应用接入租户端左菜单；未声明返回 404）——
  fastify.get(
    '/app-ops/menus',
    withOps('app-ops:permissions:read', async () => {
      const manifest = await fastify[options.name].services.getMenus();
      if (!manifest) {
        throw Object.assign(new Error('menus not declared'), { statusCode: 404 });
      }
      return manifest;
    })
  );

  // —— 日志 ——
  fastify.get(
    '/app-ops/logs',
    withOps('app-ops:logs:read', async (request, reply, payload) => {
      await auditOps(request, payload, { action: 'logs', result: 'ok', statusCode: 200 });
      return logs.read(request.query || {});
    })
  );
  fastify.get(
    '/app-ops/logs/files',
    withOps('app-ops:logs:read', async () => logs.files())
  );
  // SSE 不能走 withOps 的 JSON 封装
  fastify.get('/app-ops/logs/stream', async (request, reply) => {
    let payload;
    try {
      payload = await requireOpsScope(fastify, request, 'app-ops:logs:read');
      limiter.check(clientKeyFromRequest(request, payload));
      await auditOps(request, payload, {
        action: 'logs.stream',
        result: 'ok',
        statusCode: 200
      }).catch(() => {});
      await logs.stream(request, reply, request.query || {});
    } catch (err) {
      await auditOps(request, payload, {
        action: 'logs.stream',
        result: 'error',
        statusCode: err.statusCode || 500,
        detail: err.message
      }).catch(() => {});
      if (reply.sent || reply.raw.headersSent) {
        return;
      }
      return sendError(reply, err, cors);
    }
  });

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
    withOps('app-ops:db:read', async (request, reply, payload) => {
      await auditOps(request, payload, { action: 'db.query', result: 'ok', statusCode: 200 });
      return db.runQuery(fastify, options, request.body || {});
    })
  );
  fastify.post(
    '/app-ops/db/row/save',
    withOps('app-ops:db:write', async (request, reply, payload) => {
      await auditOps(request, payload, {
        action: 'db.write',
        result: 'ok',
        statusCode: 200,
        detail: request.body?.table
      });
      return db.saveRow(fastify, options, request.body || {});
    })
  );
  fastify.post(
    '/app-ops/db/row/remove',
    withOps('app-ops:db:write', async (request, reply, payload) => {
      await auditOps(request, payload, {
        action: 'db.write',
        result: 'ok',
        statusCode: 200,
        detail: `remove:${request.body?.table}`
      });
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
    withOps('app-ops:migrations:execute', async (request, reply, payload) => {
      await auditOps(request, payload, {
        action: `migrations.${request.body?.action}`,
        result: 'ok',
        statusCode: 200,
        detail: request.body?.file
      });
      return migrations.runAction(fastify, options, request.body || {});
    })
  );

  fastify.log.info('app-runtime: APP_OPS_ENABLED 已开启，/app-ops 远程管理可用');
});
