const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('node:fs');

module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {},
      {
        name: 'appRuntime',
        root: path.resolve(process.cwd(), './build'),
        packageJson: {},
        env: null,
        origin: null,
        runtime: {},
        cors: '*',
        static: { prefix: '/' },
        getEntry: ({ env }) => {
          if (env === 'staging') {
            return 'entry.html';
          }
          if (env === 'prod') {
            return 'entry-prod.html';
          }
          return 'index.html';
        },
        setting: {},
        readyChecks: {},
        timeout: 3000
      },
      options
    );
    options.setting = Object.assign({ name: 'setting' }, options.setting);

    fastify.register(require('@kne/fastify-setting'), options.setting);

    fastify.register(require('@kne/fastify-namespace'), {
      options,
      name: options.name,
      modules: [
        ['utils', require('./libs/utils')],
        ['services', path.resolve(__dirname, './libs/services')],
        ['controllers', path.resolve(__dirname, './libs/controllers')]
      ]
    });

    if (!options.static) {
      return;
    }

    const staticOptions = Object.assign({ prefix: '/', fallback: true }, options.static);
    const getEntryPath = () => path.join(options.root, options.getEntry({ env: options.env || fastify.config?.ENV || 'local', config: fastify.config || {} }));

    fastify.register(require('@fastify/static'), {
      root: options.root,
      prefix: staticOptions.prefix,
      decorateReply: false,
      index: path.basename(getEntryPath())
    });

    if (staticOptions.fallback) {
      fastify.setNotFoundHandler(async (request, reply) => {
        const entryPath = getEntryPath();
        if (request.method !== 'GET' || !(await fs.promises.stat(entryPath).catch(() => null))) {
          return reply.code(404).send({ message: `Route ${request.method}:${request.url} not found` });
        }
        return reply.type('text/html; charset=utf-8').send(fs.createReadStream(entryPath));
      });
    }
  },
  {
    name: 'fastify-app-runtime',
    dependencies: ['fastify-sequelize']
  }
);
