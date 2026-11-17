/** 与 @kne/fastify-oidc/platform-assertion 对齐的验签（远程侧）；避免强依赖未安装的 oidc 包 */
const { jwtVerify, createRemoteJWKSet } = require('jose');

const ASSERTION_TYP = 'platform-link+jwt';

const createPlatformAssertionVerifier = ({ clockTolerance = 5, jtiStore = null } = {}) => {
  const jwksCache = new Map();
  const getJWKS = jwksUri => {
    let set = jwksCache.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri));
      jwksCache.set(jwksUri, set);
    }
    return set;
  };

  const verify = async (token, { issuer, audience, jwksUri } = {}) => {
    if (!token || !issuer || !audience || !jwksUri) {
      throw new Error('verifyPlatformAssertion 需要 token、issuer、audience、jwksUri');
    }
    const { payload, protectedHeader } = await jwtVerify(token, getJWKS(jwksUri), {
      issuer,
      audience,
      clockTolerance,
      typ: ASSERTION_TYP
    });
    if (!payload.jti) {
      throw new Error('platform assertion 缺少 jti');
    }
    if (jtiStore) {
      if (await jtiStore.has(payload.jti)) {
        throw new Error('platform assertion jti 已使用');
      }
      const ttlMs = Math.max(1000, ((payload.exp || 0) - Math.floor(Date.now() / 1000) + clockTolerance) * 1000);
      await jtiStore.add(payload.jti, ttlMs);
    }
    return { payload, protectedHeader };
  };

  return { verify, typ: ASSERTION_TYP };
};

module.exports = { ASSERTION_TYP, createPlatformAssertionVerifier };
