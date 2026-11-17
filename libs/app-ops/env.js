const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SECRET_PATTERN = /(SECRET|PASSWORD|TOKEN|KEY|PRIVATE|CREDENTIAL)/i;
const MASK = '********';

const loadSchema = async (options, config = {}) => {
  const schemaPath = options.appOps?.envSchemaPath || config.APP_OPS_ENV_SCHEMA || process.env.APP_OPS_ENV_SCHEMA || path.resolve(process.cwd(), './server/env.schema.json');
  const candidates = [schemaPath, path.resolve(process.cwd(), './env.schema.json')];
  for (const file of candidates) {
    try {
      return { schema: JSON.parse(await fs.promises.readFile(file, 'utf8')), path: file };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  }
  return { schema: null, path: null };
};

const secretKeySet = (config = {}) => {
  const raw = config.APP_OPS_ENV_SECRET_KEYS || process.env.APP_OPS_ENV_SECRET_KEYS || '';
  return new Set(
    String(raw)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
};

const isSecretKey = (key, prop = {}, config = {}) => {
  if (prop.writeOnly === true) {
    return true;
  }
  if (secretKeySet(config).has(key)) {
    return true;
  }
  const pattern = config.APP_OPS_ENV_SECRET_PATTERN || process.env.APP_OPS_ENV_SECRET_PATTERN;
  const re = pattern ? new RegExp(pattern, 'i') : DEFAULT_SECRET_PATTERN;
  return re.test(key);
};

const readEnvValue = (key, fastify) => {
  if (fastify?.config && Object.prototype.hasOwnProperty.call(fastify.config, key)) {
    return fastify.config[key];
  }
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key];
  }
  return undefined;
};

const getEnvDeclaration = async (fastify, options) => {
  const config = fastify.config || {};
  const { schema } = await loadSchema(options, config);
  const injectedKeys = ['AUTH_MODE', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_CLIENT_ID', 'OIDC_SERVICE_CLIENT_ID', 'OIDC_SERVICE_CLIENT_SECRET', 'PORT', 'DB_TABLE_PREFIX'];
  const declared = [];
  const seen = new Set();

  if (schema?.properties) {
    const required = new Set(schema.required || []);
    for (const [key, prop] of Object.entries(schema.properties)) {
      seen.add(key);
      const secret = isSecretKey(key, prop, config);
      const raw = readEnvValue(key, fastify);
      const configured = raw != null && String(raw) !== '';
      declared.push({
        key,
        type: prop.type || 'string',
        required: required.has(key),
        default: Object.prototype.hasOwnProperty.call(prop, 'default') ? prop.default : null,
        description: prop.description || '',
        secret,
        configured,
        // 密钥真实值永不离开应用进程
        value: secret ? (configured ? MASK : null) : configured ? raw : null
      });
    }
  }

  const others = [];
  for (const key of Object.keys(process.env)) {
    if (seen.has(key) || key.startsWith('npm_') || key === 'PATH' || key === 'HOME') {
      continue;
    }
    // 仅暴露看起来像应用配置的大写键，避免泄漏整机环境
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      continue;
    }
    const secret = isSecretKey(key, {}, config);
    const raw = process.env[key];
    const configured = raw != null && String(raw) !== '';
    others.push({
      key,
      secret,
      configured,
      value: secret ? (configured ? MASK : null) : configured ? raw : null
    });
  }

  return {
    readOnly: true,
    hasSchema: !!schema,
    declared,
    others: others.slice(0, 100),
    injectedKeys
  };
};

module.exports = { getEnvDeclaration, isSecretKey, MASK };
