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

// 应用中心等服务端用 OIDC client_credentials 令牌调用：须签发给本应用 audience、为 client 令牌且含指定 scope
const verifyServiceToken = async (oidc, request, scope) => {
  const [scheme, token] = String(request.headers.authorization || '').split(' ');
  if (!oidc?.verifier || !scope || String(scheme).toLowerCase() !== 'bearer' || !token) {
    return false;
  }
  const payload = await oidc.verifier.verifyAccessToken(token).catch(() => null);
  const clientTokenClaim = oidc.options?.runtime?.claims?.clientToken;
  if (!payload || !clientTokenClaim || payload[clientTokenClaim] !== true) {
    return false;
  }
  return String(payload.scope || '')
    .split(' ')
    .includes(scope);
};

module.exports = {
  getRemoteModuleConfigFile,
  resolveConfigUrl,
  withTimeout,
  sendJson,
  verifyServiceToken
};
