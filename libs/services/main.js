const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('node:fs');

module.exports = fp(async (fastify, options) => {
  const { utils } = fastify[options.name];

  const getEnv = () => options.env || fastify.config?.ENV || 'local';

  const getOrigin = () => (options.origin || fastify.config?.ORIGIN || '').replace(/\/+$/, '');

  const getEntry = () => options.getEntry({ env: getEnv(), config: fastify.config || {} });

  const getRemoteModuleConfig = async () => {
    const filePath = path.join(options.root, utils.getRemoteModuleConfigFile(getEntry()));
    let config;
    try {
      config = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') {
        return null;
      }
      throw e;
    }
    return Object.assign({}, config, { url: utils.resolveConfigUrl(config.url, getOrigin()) });
  };

  const getRuntime = () =>
    Object.assign(
      {
        name: options.packageJson.name || null,
        version: options.packageJson.version || null,
        env: getEnv(),
        origin: getOrigin() || null
      },
      options.runtime
    );

  const getSettings = async () => {
    try {
      return await utils.withTimeout(() => fastify[options.setting.name].services.detail(), options.timeout);
    } catch (e) {
      fastify.log.warn(e, 'app-runtime: load settings failed');
      return null;
    }
  };

  const getAppConfig = async () => ({
    runtime: getRuntime(),
    settings: await getSettings()
  });

  const getHealth = () => ({
    status: 'ok',
    name: options.packageJson.name || null,
    version: options.packageJson.version || null,
    uptime: Math.round(process.uptime())
  });

  const checkReady = async () => {
    const checks = Object.assign({}, fastify.sequelize?.instance ? { database: () => fastify.sequelize.instance.authenticate() } : {}, options.readyChecks);
    const results = await Promise.all(
      Object.keys(checks).map(async name => {
        try {
          await utils.withTimeout(checks[name], options.timeout);
          return [name, 'ok'];
        } catch (e) {
          fastify.log.warn(e, `app-runtime: ready check [${name}] failed`);
          return [name, e.code === 'TIMEOUT' ? 'timeout' : 'error'];
        }
      })
    );
    return {
      status: results.every(([, result]) => result === 'ok') ? 'ok' : 'error',
      checks: Object.fromEntries(results)
    };
  };

  Object.assign(fastify[options.name].services, {
    getEnv,
    getOrigin,
    getEntry,
    getRemoteModuleConfig,
    getAppConfig,
    getHealth,
    checkReady
  });
});
