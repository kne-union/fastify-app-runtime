const path = require('node:path');
const { Readable } = require('node:stream');

// 与 @kne/npm-tools entryHtml 保持一致：entry-cn-prod.html → remote-module-config-cn-prod.json；entry.html / index.html → remote-module-config.json
const getRemoteModuleConfigFile = entry => {
  const base = path.basename(entry, path.extname(entry));
  const matched = base.match(/^(?:entry|index)(.*)$/);
  const suffix = matched ? matched[1] : `-${base}`;
  return `remote-module-config${suffix}.json`;
};

const resolveConfigUrl = (url, origin) => {
  if (/^https?:\/\//i.test(url || '')) {
    return url;
  }
  return url ? `${origin}/${url.replace(/^\/+/, '')}` : origin;
};

const withTimeout = (task, ms) => {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`Timeout after ${ms}ms`), { code: 'TIMEOUT' })), ms);
    })
  ]).finally(() => clearTimeout(timer));
};

// 以流返回，避免被 @kne/fastify-response-data-format 等 onSend 钩子包装成 { code, data }
const sendJson = (reply, { statusCode = 200, data, cors }) => {
  reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'no-cache');
  if (cors) {
    reply.header('Access-Control-Allow-Origin', cors);
  }
  return Readable.from([JSON.stringify(data)]);
};

const hasScope = (payload, scope) =>
  String(payload?.scope || '')
    .split(/\s+/)
    .filter(Boolean)
    .includes(scope);

/**
 * 是否为 client_credentials 类服务令牌。
 * 跨平台时宿主签发的 client_token claim 名可能与本机 namespace 不同，不能只认本机 claims.clientToken。
 */
const isClientCredentialsPayload = (payload, clientTokenClaim) => {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (clientTokenClaim && payload[clientTokenClaim] === true) {
    return true;
  }
  if (Object.keys(payload).some(key => /(?:^|\/)client_token$/i.test(key) && payload[key] === true)) {
    return true;
  }
  // client_credentials 常见形态：sub 与 client_id 同为客户端标识（如 app-center-docs）
  if (payload.client_id && String(payload.sub) === String(payload.client_id)) {
    return true;
  }
  return false;
};

const readBearerPayload = async (oidc, request) => {
  const [scheme, token] = String(request.headers.authorization || '').split(' ');
  if (!oidc?.verifier || String(scheme).toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return oidc.verifier.verifyAccessToken(token).catch(() => null);
};

// 应用中心等服务端用 OIDC client_credentials 令牌调用：验签通过且含指定 scope
// 跨平台时宿主 client_token claim 名可能与本机不同，故不再强制本机 claim；由调用方对 client 令牌做兜底拦截
const verifyServiceToken = async (oidc, request, scope) => {
  if (!scope) {
    return false;
  }
  const payload = await readBearerPayload(oidc, request);
  if (!payload) {
    return false;
  }
  if (!hasScope(payload, scope)) {
    return false;
  }
  const clientTokenClaim = oidc.options?.runtime?.claims?.clientToken;
  // 优先确认是服务令牌；无 client claim 但带 scope 也放行（与 app-ops requireOpsScope 兼容）
  if (isClientCredentialsPayload(payload, clientTokenClaim)) {
    return true;
  }
  return true;
};

module.exports = {
  getRemoteModuleConfigFile,
  resolveConfigUrl,
  withTimeout,
  sendJson,
  hasScope,
  isClientCredentialsPayload,
  readBearerPayload,
  verifyServiceToken
};
