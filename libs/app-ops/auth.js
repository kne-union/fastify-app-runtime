const { verifyServiceToken } = require('../utils');

const hasScope = (payload, scope) =>
  String(payload?.scope || '')
    .split(/\s+/)
    .filter(Boolean)
    .includes(scope);

/**
 * 校验平台服务令牌是否包含所需 scope；失败抛出带 statusCode 的 Error。
 */
const requireOpsScope = async (fastify, request, scope) => {
  const oidc = fastify.oidc;
  if (!oidc?.verifier) {
    const err = new Error('OIDC 未就绪，无法校验运维令牌');
    err.statusCode = 503;
    throw err;
  }
  const [scheme, token] = String(request.headers.authorization || '').split(' ');
  if (String(scheme).toLowerCase() !== 'bearer' || !token) {
    const err = new Error('需要 Bearer 服务令牌');
    err.statusCode = 401;
    throw err;
  }
  // 多 scope：verifyServiceToken 只认单一 scope；这里自行验签再检查 scope 集合
  let payload;
  try {
    payload = await oidc.verifier.verifyAccessToken(token);
  } catch (e) {
    const err = new Error('服务令牌无效');
    err.statusCode = 401;
    throw err;
  }
  const clientTokenClaim = oidc.options?.runtime?.claims?.clientToken;
  if (!payload || (clientTokenClaim && payload[clientTokenClaim] !== true)) {
    // 兼容：部分服务令牌可能无 clientToken claim，但仍须带 scope
    if (!hasScope(payload, scope)) {
      const err = new Error(`缺少 scope：${scope}`);
      err.statusCode = 403;
      throw err;
    }
  } else if (!hasScope(payload, scope)) {
    const err = new Error(`缺少 scope：${scope}`);
    err.statusCode = 403;
    throw err;
  }
  return payload;
};

const requireAnyOpsScope = async (fastify, request, scopes = []) => {
  let lastErr;
  for (const scope of scopes) {
    try {
      return await requireOpsScope(fastify, request, scope);
    } catch (e) {
      lastErr = e;
      if (e.statusCode === 401 || e.statusCode === 503) {
        throw e;
      }
    }
  }
  throw lastErr || Object.assign(new Error('缺少运维 scope'), { statusCode: 403 });
};

/**
 * 本地 break-glass：须先 user 再 admin（与业务控制器 onRequest 链一致）。
 * account.authenticate.admin 依赖 request.userInfo；只调 admin 会在 userInfo 为空时读 id 崩成 500。
 * 有 fastify-oidc 时优先走 oidc.authenticate.user/admin（统一 Bearer / PKCE）。
 */
const requireLocalAdmin = async (fastify, request) => {
  const wrap = async fn => {
    try {
      await fn(request);
    } catch (e) {
      if (e && typeof e.statusCode === 'number') {
        throw e;
      }
      const statusCode = e?.statusCode || e?.status || 401;
      const err = new Error(e?.message || '未登录或无管理员权限');
      err.statusCode = statusCode >= 400 ? statusCode : 401;
      throw err;
    }
  };

  if (fastify.oidc?.authenticate?.user) {
    await wrap(fastify.oidc.authenticate.user);
    if (fastify.oidc.authenticate.admin) {
      await wrap(fastify.oidc.authenticate.admin);
    }
    return request.userInfo || request.user;
  }

  const account = fastify.account;
  if (!account?.authenticate) {
    const err = new Error('未配置本地账号认证，无法管理平台登记');
    err.statusCode = 503;
    throw err;
  }
  const { admin, user } = account.authenticate;
  if (user) {
    await wrap(user);
  }
  if (admin) {
    await wrap(admin);
    return request.userInfo || request.user;
  }
  if (user) {
    return request.userInfo || request.user;
  }
  const err = new Error('未配置本地管理员认证');
  err.statusCode = 503;
  throw err;
};

module.exports = {
  hasScope,
  requireOpsScope,
  requireAnyOpsScope,
  requireLocalAdmin,
  verifyServiceToken
};
