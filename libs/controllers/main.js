const fp = require('fastify-plugin');
const { str, num, any, obj, response, success } = require('../schema/response');

const TAG_RUNTIME = '应用运行时-运行信息';
const TAG_HEALTH = '应用运行时-健康检查';
const TAG_OPEN_API = '应用运行时-接口文档';

const readyResult = description =>
  response(description, {
    properties: {
      status: str('总体结果：ok 全部通过，error 有检查未通过'),
      checks: obj('各项检查结果 { [检查名]: ok | error | timeout }；注册了 fastify-sequelize 时包含 database')
    }
  });

module.exports = fp(async (fastify, options) => {
  const { services, utils } = fastify[options.name];
  const cors = options.cors;

  fastify.get(
    '/remote-module-config.json',
    {
      schema: {
        tags: [TAG_RUNTIME],
        summary: '远程组件配置',
        description: '按当前环境的入口 HTML 读取构建产物中的 remote-module-config*.json，url 为空或相对路径时以 origin 补全',
        response: Object.assign(
          success(
            '构建产物中的远程组件配置原文，url 已补全',
            obj('远程组件配置', {
              url: str('远程组件地址（绝对地址）')
            })
          ),
          { 404: response('当前环境没有对应的配置文件', { properties: { message: str('错误信息') } }) }
        )
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
        tags: [TAG_HEALTH],
        summary: '存活检查',
        description: '进程可响应即返回 200，不检查外部依赖',
        response: success('进程存活', {
          properties: {
            status: str('固定为 ok'),
            name: str('应用包名'),
            version: str('应用版本'),
            uptime: num('进程运行时长（秒）')
          }
        })
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
        tags: [TAG_HEALTH],
        summary: '就绪检查',
        description: '并行执行数据库与自定义就绪检查，全部通过返回 200，否则返回 503',
        response: {
          200: readyResult('全部检查通过'),
          503: readyResult('有检查失败或超时')
        }
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
        tags: [TAG_RUNTIME],
        summary: '应用设置',
        description: '返回运行信息与 fastify-setting 中已启用的设置项',
        response: success('运行信息与设置项', {
          properties: {
            runtime: obj('运行信息，可由插件 runtime 选项追加字段', {
              name: str('应用包名'),
              version: str('应用版本'),
              env: str('运行环境'),
              origin: str('应用访问地址，未配置为 null')
            }),
            settings: any('fastify-setting 中已启用的设置项，读取失败或超时为 null')
          }
        })
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
        tags: [TAG_OPEN_API],
        summary: 'OpenAPI 文档',
        description: '返回 @fastify/swagger 收集的当前系统 OpenAPI 文档，需要登录；也接受含 open-api:read scope 的服务令牌',
        response: success('OpenAPI 文档')
      }
    },
    async (request, reply) => {
      return utils.sendJson(reply, { data: fastify.swagger(), cors });
    }
  );
});
