const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('node:fs');
const pwaDocument = require('@kne/pwa-document');
const { verifyServiceToken } = require('./libs/utils');

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
        pwa: null,
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
        timeout: 3000,
        openApi: {}
      },
      options
    );
    options.setting = Object.assign({ name: 'setting' }, options.setting);
    options.openApi =
      options.openApi &&
      Object.assign(
        {
          path: '/open-api.json',
          serviceScope: 'open-api:read',
          getAuthenticate: () => {
            if (!fastify.account?.authenticate?.admin) {
              return null;
            }
            const { user } = fastify.account.authenticate;
            return [
              async request => {
                if (await verifyServiceToken(fastify.oidc, request, options.openApi.serviceScope)) {
                  return;
                }
                await user(request);
              }
            ];
          }
        },
        options.openApi
      );

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

    const staticOptions = Object.assign({ prefix: '/', fallback: true, manifestFiles: [] }, options.static);
    const pwaEntries = (options.pwa && options.pwa.entries) || [];
    const getEntryPath = () => path.join(options.root, options.getEntry({ env: options.env || fastify.config?.ENV || 'local', config: fastify.config || {} }));

    fastify.register(require('@fastify/static'), {
      root: options.root,
      prefix: staticOptions.prefix,
      decorateReply: false,
      index: path.basename(getEntryPath())
    });

    // @fastify/static 会在 setHeaders 之后按扩展名覆盖 content-type，manifest 需单独路由
    staticOptions.manifestFiles.forEach(fileName => {
      fastify.get(`${staticOptions.prefix.replace(/\/+$/, '')}/${fileName}`, async (request, reply) => {
        const content = await fs.promises.readFile(path.join(options.root, fileName), 'utf8').catch(() => null);
        if (content === null) {
          return reply.callNotFound();
        }
        return reply.type('application/manifest+json; charset=utf-8').send(content);
      });
    });

    if (staticOptions.fallback) {
      fastify.setNotFoundHandler(async (request, reply) => {
        const entryPath = getEntryPath();
        if ((request.method !== 'GET' && request.method !== 'HEAD') || !(await fs.promises.stat(entryPath).catch(() => null))) {
          return reply.code(404).send({ message: `Route ${request.method}:${request.url} not found` });
        }
        const pwaEntry = pwaEntries.length ? pwaDocument.matchPwaEntry(request.url, pwaEntries) : null;
        if (!pwaEntry) {
          return reply.type('text/html; charset=utf-8').send(fs.createReadStream(entryPath));
        }
        const html = await fs.promises.readFile(entryPath, 'utf8');
        return reply.type('text/html; charset=utf-8').send(pwaDocument.applyPwaHtml(html, pwaEntry));
      });
    }
  },
  {
    name: 'fastify-app-runtime',
    dependencies: ['fastify-sequelize']
  }
);
