const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services, utils } = fastify[options.name];
  const cors = options.cors;

  fastify.get(
    '/remote-module-config.json',
    {
      schema: {
        summary: '远程组件配置',
        description: '按当前环境的入口 HTML 读取构建产物中的 remote-module-config*.json，url 为空或相对路径时以 origin 补全'
      }
    },
    async (request, reply) => {
      const config = await services.getRemoteModuleConfig();
      if (!config) {
        return utils.sendJson(reply, { statusCode: 404, data: { message: 'remote-module-config not found' }, cors });
      }
      return utils.sendJson(reply, { data: config, cors });
    }
  );

  fastify.get(
    '/health',
    {
      schema: {
        summary: '存活检查',
        description: '进程可响应即返回 200，不检查外部依赖'
      }
    },
    async (request, reply) => {
      return utils.sendJson(reply, { data: services.getHealth(), cors });
    }
  );

  fastify.get(
    '/ready',
    {
      schema: {
        summary: '就绪检查',
        description: '并行执行数据库与自定义就绪检查，全部通过返回 200，否则返回 503'
      }
    },
    async (request, reply) => {
      const result = await services.checkReady();
      return utils.sendJson(reply, { statusCode: result.status === 'ok' ? 200 : 503, data: result, cors });
    }
  );

  fastify.get(
    '/app-config.json',
    {
      schema: {
        summary: '应用设置',
        description: '返回运行信息与 fastify-setting 中已启用的设置项'
      }
    },
    async (request, reply) => {
      return utils.sendJson(reply, { data: await services.getAppConfig(), cors });
    }
  );

  const authenticate = options.openApi && options.openApi.getAuthenticate();
  if (!authenticate || authenticate.length === 0) {
    return;
  }
  if (typeof fastify.swagger !== 'function') {
    fastify.log.warn('app-runtime: open-api disabled, register @fastify/swagger before other routes to enable it');
    return;
  }

  fastify.get(
    options.openApi.path,
    {
      onRequest: authenticate,
      schema: {
        summary: 'OpenAPI 文档',
        description: '返回 @fastify/swagger 收集的当前系统 OpenAPI 文档，需要登录'
      }
    },
    async (request, reply) => {
      return utils.sendJson(reply, { data: fastify.swagger(), cors });
    }
  );
});
