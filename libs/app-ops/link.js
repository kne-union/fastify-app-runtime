const crypto = require('node:crypto');
const { decodeJwt } = require('jose');
const { createPlatformAssertionVerifier } = require('./platform-assertion-fallback');

const KEY_TTL_MS = 24 * 60 * 60 * 1000;

const discovery = async platformOrigin => {
  const origin = String(platformOrigin).replace(/\/+$/, '');
  const url = `${origin}/oidc/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const err = new Error(`无法 discovery：HTTP ${res.status}`);
    err.statusCode = 400;
    throw err;
  }
  const doc = await res.json();
  if (!doc.issuer || !doc.jwks_uri) {
    const err = new Error('openid-configuration 缺少 issuer / jwks_uri');
    err.statusCode = 400;
    throw err;
  }
  return { issuer: String(doc.issuer).replace(/\/+$/, ''), jwksUri: doc.jwks_uri };
};

const encodeInstallKey = payload => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const decodeInstallKey = installKey => {
  try {
    return JSON.parse(Buffer.from(String(installKey), 'base64url').toString('utf8'));
  } catch (e) {
    const err = new Error('installKey 无效');
    err.statusCode = 400;
    throw err;
  }
};

const createLinkService = ({ store, options, fastify }) => {
  const packageJson = options.packageJson || {};
  const verifier = createPlatformAssertionVerifier({ clockTolerance: 5 });
  const getBaseUrl = () => (options.origin || fastify.config?.ORIGIN || '').replace(/\/+$/, '');

  /** 宿主服务端可达的 API 根；本地 ORIGIN 常为前端端口，需与 PORT 区分 */
  const getApiBaseUrl = () => {
    const explicit = options.apiOrigin || fastify.config?.APP_OPS_API_BASE_URL || process.env.APP_OPS_API_BASE_URL;
    if (explicit) {
      return String(explicit).replace(/\/+$/, '');
    }
    const base = getBaseUrl();
    const port = fastify.config?.PORT || process.env.PORT;
    if (!base || !port) {
      return base;
    }
    try {
      const u = new URL(base);
      const defaultPort = u.protocol === 'https:' ? '443' : '80';
      const originPort = u.port || defaultPort;
      if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && String(originPort) !== String(port)) {
        return `${u.protocol}//${u.hostname}:${port}`;
      }
    } catch (e) {
      // ignore
    }
    return base;
  };

  const register = async ({ platformOrigin, platformName, remark } = {}) => {
    const origin = String(platformOrigin || '').replace(/\/+$/, '');
    if (!origin) {
      const err = new Error('platformOrigin 必填');
      err.statusCode = 400;
      throw err;
    }
    if (!/^https?:\/\//i.test(origin)) {
      const err = new Error('platformOrigin 须为 http(s) URL');
      err.statusCode = 400;
      throw err;
    }
    const { issuer, jwksUri } = await discovery(origin);
    const installId = crypto.randomUUID();
    const installSecret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + KEY_TTL_MS).toISOString();
    const baseUrl = getBaseUrl();
    const appName = packageJson.name || 'app';
    await store.upsertPlatform({
      platformOrigin: origin,
      platformName: platformName || origin,
      remark: remark || '',
      issuer,
      jwksUri,
      installId,
      secretHash: store.hashSecret(installSecret),
      status: 'issued',
      expiresAt,
      pairedAt: null,
      audience: null,
      spaClientId: null,
      serviceClientId: null,
      serviceClientSecretEnc: null,
      oidc: null
    });
    return {
      platformOrigin: origin,
      platformName: platformName || origin,
      issuer,
      status: 'issued',
      expiresAt,
      installKey: encodeInstallKey({
        v: 1,
        baseUrl,
        apiBaseUrl: getApiBaseUrl(),
        appName,
        appLabel: packageJson.description || appName,
        installId,
        installSecret,
        platformOrigin: origin,
        expiresAt
      })
    };
  };

  const listPlatforms = async () => {
    const platforms = await store.getPlatforms();
    const logs = await store.listAccessLogs({ limit: 500, offset: 0 });
    const lastByOrigin = new Map();
    // accessLogs 新记录在前
    for (const row of logs.pageData || []) {
      if (!row?.platformOrigin || lastByOrigin.has(row.platformOrigin)) {
        continue;
      }
      lastByOrigin.set(row.platformOrigin, row.at || null);
    }
    return platforms.map(p => ({
      platformOrigin: p.platformOrigin,
      platformName: p.platformName,
      issuer: p.issuer,
      status: p.status,
      expiresAt: p.expiresAt || null,
      pairedAt: p.pairedAt || null,
      remark: p.remark || '',
      lastAccessAt: lastByOrigin.get(p.platformOrigin) || null
    }));
  };

  const redeem = async ({ installId, installSecret, assertion }, requestMeta = {}) => {
    const fail = async (message, statusCode = 400) => {
      if (installId) {
        await store.bumpRedeemFailure(installId);
      }
      await store.appendAccessLog({
        platformOrigin: null,
        action: 'redeem',
        result: 'denied',
        statusCode,
        detail: message,
        ip: requestMeta.ip,
        userAgent: requestMeta.userAgent
      });
      const err = new Error(message);
      err.statusCode = statusCode;
      throw err;
    };

    if (!installId || !installSecret || !assertion) {
      await fail('缺少 installId / installSecret / assertion');
    }
    const lock = await store.getRedeemFailure(installId);
    if (lock.lockedUntil && lock.lockedUntil > Date.now()) {
      await fail('兑换次数过多，请稍后再试', 429);
    }
    const row = await store.findPlatformByInstallId(installId);
    if (!row) {
      await fail('installId 无效');
    }
    if (row.status === 'paired') {
      await fail('key 已失效，请在远程重新生成');
    }
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      await fail('key 已过期');
    }
    if (row.secretHash !== store.hashSecret(installSecret)) {
      // 旧实现曾在 redeem 成功后立即轮换 secret，主平台若随后 ensureOidc/activate 失败会导致「密钥无效」且无法重试
      await fail('installSecret 无效或已失效，请在远程「平台注册」重新生成 installKey', 401);
    }

    let payload;
    try {
      ({ payload } = await verifier.verify(assertion, {
        issuer: row.issuer,
        audience: getBaseUrl(),
        jwksUri: row.jwksUri
      }));
    } catch (e) {
      await fail(`平台断言无效：${e.message}`, 401);
    }
    if (await store.hasJti(payload.jti)) {
      await fail('断言 jti 已使用', 401);
    }
    await store.addJti(payload.jti, Math.max(1000, (payload.exp || 0) * 1000 - Date.now() + 5000));
    await store.clearRedeemFailure(installId);
    // 不在 redeem 时轮换 secret：activate 成功后再作废；主平台中途失败时可带同一 key 重试
    await store.upsertPlatform(
      Object.assign({}, row, {
        status: 'pending_activate'
      })
    );

    const permissions = typeof options.appOps?.getPermissions === 'function' ? await options.appOps.getPermissions({ fastify }) : [];
    const capabilities = Object.assign(
      {
        logs: true,
        envRead: true,
        dbRead: true,
        dbWrite: false,
        openApi: true,
        migrationsRead: true,
        migrationsExecute: false
      },
      options.appOps?.capabilities || {}
    );

    await store.appendAccessLog({
      platformOrigin: row.platformOrigin,
      issuer: row.issuer,
      action: 'redeem',
      result: 'ok',
      statusCode: 200,
      actor: payload.sub || payload.client_id || null,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent
    });

    return {
      name: packageJson.name || 'app',
      label: packageJson.description || packageJson.name || 'app',
      description: packageJson.description || '',
      icon: null,
      entries: options.appOps?.entries || [{ label: '首页', path: '/', showInCenter: true }],
      permissions,
      capabilities,
      platformOrigin: row.platformOrigin,
      issuer: row.issuer
    };
  };

  // 新版 fastify-oidc 的 standalone 应用能服务已配对平台的租户：平台把租户变更通知推到这里
  const getTenantSyncUri = () => {
    const prefix = fastify.oidc?.platformContexts ? fastify.oidc.options?.prefix : null;
    const apiBaseUrl = getApiBaseUrl();
    return prefix && apiBaseUrl ? `${apiBaseUrl}${prefix}/tenant-sync` : null;
  };

  const activate = async ({ assertion, issuer, audience, clientId, serviceClientId, serviceClientSecret, appCode }, requestMeta = {}) => {
    let iss;
    try {
      iss = decodeJwt(assertion).iss;
    } catch (e) {
      const err = new Error('assertion 无效');
      err.statusCode = 401;
      throw err;
    }
    const platforms = await store.getPlatforms();
    const matched = platforms.find(p => p.issuer === iss || p.issuer === String(iss).replace(/\/+$/, ''));
    if (!matched) {
      const err = new Error('未登记的平台 issuer');
      err.statusCode = 403;
      throw err;
    }
    let payload;
    try {
      ({ payload } = await verifier.verify(assertion, {
        issuer: matched.issuer,
        audience: getBaseUrl(),
        jwksUri: matched.jwksUri
      }));
    } catch (e) {
      const err = new Error(`平台断言无效：${e.message}`);
      err.statusCode = 401;
      throw err;
    }
    if (await store.hasJti(payload.jti)) {
      const err = new Error('断言 jti 已使用');
      err.statusCode = 401;
      throw err;
    }
    await store.addJti(payload.jti, Math.max(1000, (payload.exp || 0) * 1000 - Date.now() + 5000));

    const next = Object.assign({}, matched, {
      status: 'paired',
      pairedAt: new Date().toISOString(),
      // activate 成功后再作废 installSecret，防止半成品占用导致无法重试
      secretHash: store.hashSecret(crypto.randomBytes(16).toString('hex')),
      audience: audience || matched.audience,
      spaClientId: clientId || matched.spaClientId,
      serviceClientId: serviceClientId || matched.serviceClientId,
      serviceClientSecretEnc: serviceClientSecret ? Buffer.from(String(serviceClientSecret)).toString('base64') : matched.serviceClientSecretEnc,
      oidc: {
        issuer: issuer || matched.issuer,
        audience: audience || null,
        clientId: clientId || null,
        serviceClientId: serviceClientId || null,
        serviceClientSecret: serviceClientSecret || null,
        appCode: appCode || null
      }
    });
    await store.upsertPlatform(next);

    if (fastify.oidc?.platforms) {
      fastify.oidc.platforms.upsert({
        platformOrigin: matched.platformOrigin,
        platformName: matched.platformName,
        issuer: issuer || matched.issuer,
        audience: audience || `${matched.platformOrigin}/app/${packageJson.name || 'app'}/api`,
        spaClientId: clientId,
        serviceClientId,
        serviceClientSecret,
        appCode,
        jwksUri: matched.jwksUri,
        status: 'paired',
        pairedAt: next.pairedAt
      });
    }

    await store.appendAccessLog({
      platformOrigin: matched.platformOrigin,
      issuer: matched.issuer,
      action: 'activate',
      result: 'ok',
      statusCode: 200,
      actor: payload.sub || null,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent
    });

    return { ok: true, status: 'paired', tenantSyncUri: getTenantSyncUri() };
  };

  const unlink = async platformOrigin => {
    const removed = await store.removePlatform(platformOrigin);
    if (fastify.oidc?.platforms) {
      fastify.oidc.platforms.remove(platformOrigin);
    }
    await store.appendAccessLog({
      platformOrigin,
      action: 'unlink',
      result: removed ? 'ok' : 'error',
      statusCode: removed ? 200 : 404
    });
    return { ok: removed };
  };

  const status = async ({ issuer } = {}) => {
    const platforms = await store.getPlatforms();
    if (issuer) {
      const key = String(issuer).replace(/\/+$/, '');
      const one = platforms.find(p => p.issuer === key || p.issuer === issuer);
      return one ? { paired: one.status === 'paired', platformOrigin: one.platformOrigin, issuer: one.issuer, pairedAt: one.pairedAt, tenantSyncUri: getTenantSyncUri() } : { paired: false };
    }
    return {
      platforms: platforms.map(p => ({
        platformOrigin: p.platformOrigin,
        issuer: p.issuer,
        status: p.status,
        paired: p.status === 'paired',
        pairedAt: p.pairedAt
      }))
    };
  };

  return { register, listPlatforms, redeem, activate, unlink, status, decodeInstallKey, encodeInstallKey };
};

module.exports = { createLinkService, discovery, encodeInstallKey, decodeInstallKey, KEY_TTL_MS };
