const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('node:fs');
const pwaDocument = require('@kne/pwa-document');
const { verifyServiceToken, isClientCredentialsPayload, readBearerPayload } = require('./libs/utils');

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
        openApi: {},
        /**
         * 菜单 manifest（open-menus.json）：声明子应用要接入租户端左菜单的菜单。
         * 来源优先级：manifest（对象或 async 函数）> file（默认 {cwd}/menus.json）；都没有则接口返回 404。
         * 鉴权复用 openApi.getAuthenticate；openApi 为 false 或无鉴权时不注册。
         */
        menus: {},
        /**
         * 远程管理（App Ops）。也可用环境变量 APP_OPS_ENABLED=true|1|yes|on 开启。
         * 未开启时不注册任何 /app-ops 路由。
         * @type {{ enabled?: boolean, capabilities?: object, getPermissions?: Function, dataDir?: string, entries?: array }|boolean|undefined}
         */
        appOps: undefined
      },
      options
    );
    if (options.appOps === true) {
      options.appOps = { enabled: true };
    } else if (options.appOps === false) {
      options.appOps = { enabled: false };
    } else {
      options.appOps = Object.assign({}, options.appOps);
    }
    options.menus = options.menus === false ? false : Object.assign({ path: '/open-menus.json', file: path.resolve(process.cwd(), 'menus.json'), manifest: null }, options.menus);
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
                // client_credentials 令牌 sub 常为 client_id（如 app-center-docs），绝不能再走 account.user 查 bigint
                const payload = await readBearerPayload(fastify.oidc, request);
                const clientTokenClaim = fastify.oidc?.options?.runtime?.claims?.clientToken;
                if (payload && isClientCredentialsPayload(payload, clientTokenClaim)) {
                  const err = new Error(`缺少 scope：${options.openApi.serviceScope}`);
                  err.statusCode = 403;
                  throw err;
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

    // 远程管理：由 APP_OPS_ENABLED / options.appOps.enabled 总开关控制（默认关）
    fastify.register(require('./libs/app-ops/register'), options);

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
      const manifestSchema = {
        tags: ['应用运行时-前端资源'],
        summary: `PWA manifest：${fileName}`,
        description: '读取构建目录中的同名文件并以 application/manifest+json 返回，文件不存在时交给 404 处理（开启 fallback 时返回入口 HTML）',
        response: { 200: { description: 'manifest 文件原文' } }
      };
      fastify.get(`${staticOptions.prefix.replace(/\/+$/, '')}/${fileName}`, { schema: manifestSchema }, async (request, reply) => {
        const content = await fs.promises.readFile(path.join(options.root, fileName), 'utf8').catch(() => null);
        if (content === null) {
          return reply.callNotFound();
        }
        return reply.type('application/manifest+json; charset=utf-8').send(content);
      });
    });

    // 兼容尚未升级的 @kne/pwa-document（无 injectEmbedBridgeHtml 时原样返回）
    const withEmbedBridge = html => (typeof pwaDocument.injectEmbedBridgeHtml === 'function' ? pwaDocument.injectEmbedBridgeHtml(html) : html);

    // 静态入口与 SPA fallback 的 HTML 都注入 embed bridge，供应用中心「主页」iframe 前进/后退
    fastify.addHook('onSend', async (request, reply, payload) => {
      const contentType = reply.getHeader('content-type');
      if (!contentType || !String(contentType).includes('text/html') || payload == null) {
        return payload;
      }
      const toText = async raw => {
        if (typeof raw === 'string') {
          return raw;
        }
        if (Buffer.isBuffer(raw)) {
          return raw.toString('utf8');
        }
        if (typeof raw.pipe === 'function' || typeof raw[Symbol.asyncIterator] === 'function') {
          const chunks = [];
          for await (const chunk of raw) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          return Buffer.concat(chunks).toString('utf8');
        }
        return null;
      };
      const text = await toText(payload);
      return text == null ? payload : withEmbedBridge(text);
    });

    if (staticOptions.fallback) {
      fastify.setNotFoundHandler(async (request, reply) => {
        const entryPath = getEntryPath();
        if ((request.method !== 'GET' && request.method !== 'HEAD') || !(await fs.promises.stat(entryPath).catch(() => null))) {
          return reply.code(404).send({ message: `Route ${request.method}:${request.url} not found` });
        }
        const html = await fs.promises.readFile(entryPath, 'utf8');
        const pwaEntry = pwaEntries.length ? pwaDocument.matchPwaEntry(request.url, pwaEntries) : null;
        const body = pwaEntry ? pwaDocument.applyPwaHtml(html, pwaEntry) : html;
        return reply.type('text/html; charset=utf-8').send(withEmbedBridge(body));
      });
    }
  },
  {
    name: 'fastify-app-runtime',
    dependencies: ['fastify-sequelize']
  }
);
