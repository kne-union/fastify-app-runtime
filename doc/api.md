### 配置项

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| name | string | 否 | `appRuntime` | 命名空间名，挂载为 `fastify[name]` |
| root | string | 否 | `{cwd}/build` | 前端构建产物目录 |
| packageJson | object | 否 | `{}` | 应用 `package.json`，取 `name`、`version` |
| env | string | 否 | `fastify.config.ENV`，再缺省为 `local` | 运行环境 |
| origin | string | 否 | `fastify.config.ORIGIN` | 应用对外地址，用于补全远程组件 url，末尾 `/` 会被去掉 |
| runtime | object | 否 | `{}` | 合并进 `/app-config.json` 的 `runtime` 字段 |
| cors | string / boolean | 否 | `*` | 公开接口的 `Access-Control-Allow-Origin`，`false` 不设置 |
| static | object / boolean | 否 | `{ prefix: '/' }` | 前端托管配置，`false` 不托管 |
| static.prefix | string | 否 | `/` | 静态资源路由前缀 |
| static.fallback | boolean | 否 | `true` | 是否注册 NotFound 回落入口页；宿主已有 `setNotFoundHandler` 时设为 `false` |
| getEntry | function | 否 | 见下 | `({ env, config }) => string`，返回入口 HTML 文件名 |
| setting | object | 否 | `{}` | 透传给 `@kne/fastify-setting` 的参数（`name` 默认 `setting`） |
| readyChecks | object | 否 | `{}` | 自定义就绪检查，`{ 名称: () => Promise }` |
| timeout | number | 否 | `3000` | 读取设置与每项就绪检查的超时（毫秒） |
| openApi | object / boolean | 否 | `{}` | OpenAPI 文档接口配置，`false` 不注册 |
| openApi.path | string | 否 | `/open-api.json` | 文档接口路径 |
| openApi.serviceScope | string | 否 | `open-api:read` | 默认鉴权中放行的 OIDC 服务令牌 scope |
| openApi.getAuthenticate | function | 否 | OIDC 服务令牌，或 `fastify.account` 的 user + admin | 返回 `onRequest` 鉴权数组；返回空值或空数组时不注册接口 |

默认 `getEntry`：

| env | 入口 | 远程组件配置 |
| --- | --- | --- |
| `staging` | `entry.html` | `remote-module-config.json` |
| `prod` | `entry-prod.html` | `remote-module-config-prod.json` |
| 其它 | `index.html` | `remote-module-config.json` |

自定义入口时配置文件名按同一规则推导：`entry-cn-prod.html` → `remote-module-config-cn-prod.json`，`main.html` → `remote-module-config-main.json`。

`setting` 常用参数（完整参数见 `@kne/fastify-setting`）：

| 属性名 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| prefix | string | `/api/setting` | 设置接口前缀 |
| name | string | `setting` | 命名空间名 |
| setting | object | `{}` | 固定设置值，覆盖数据库中的同名项 |
| getAuthenticate | function | `fastify.account` 的 user + admin | 保存设置接口的鉴权 |

> **注意**：本插件内部注册 `@kne/fastify-setting`，业务项目不要再单独注册，否则命名空间重复导致启动失败。

### 接口

以下接口均挂在根路径（`openApi.path` 可自定义），返回原始 JSON（不经 `{ code, data }` 包装），带 `Cache-Control: no-cache` 与 `cors` 指定的跨域头。

#### GET /remote-module-config.json

按当前入口读取构建产物中的远程组件配置，`url` 为空或相对路径时以 `origin` 补全。文件不存在返回 404。

```json
{
  "name": "ai-interview-flowup",
  "url": "https://cdn.example.com/ai-interview-flowup/cn-staging/adf8e0d",
  "tpl": "{{url}}",
  "version": "0_1_194"
}
```

#### GET /health

进程存活即返回 200，不检查外部依赖。

```json
{ "status": "ok", "name": "ai-interview-flowup", "version": "0.1.194", "uptime": 3600 }
```

#### GET /ready

并行执行就绪检查：已注册 `fastify-sequelize` 时自动包含 `database`（`sequelize.authenticate()`），再加上 `readyChecks`。全部通过返回 200，任一失败返回 503；单项结果为 `ok`、`error` 或 `timeout`，错误详情只写日志。

```json
{ "status": "error", "checks": { "database": "ok", "redis": "timeout" } }
```

#### GET /app-config.json

返回运行信息与已启用的设置项。读取设置失败或超时时 `settings` 为 `null`，接口仍返回 200。

```json
{
  "runtime": { "name": "ai-interview-flowup", "version": "0.1.194", "env": "staging", "origin": "https://staging.example.com" },
  "settings": { "systemType": "saas", "siteTitle": { "zh": "演示系统" } }
}
```

#### GET /open-api.json

返回 `@fastify/swagger` 收集的当前系统 OpenAPI 文档（即 `fastify.swagger()`），未通过鉴权返回 401。默认满足以下任一即可访问：

| 凭证 | 说明 |
| --- | --- |
| OIDC 服务令牌 | 宿主已注册 `@kne/fastify-oidc`；`Authorization: Bearer` 为 IdP 以 client_credentials 签发给本应用 audience 的令牌，且 scope 含 `openApi.serviceScope`。应用中心 MCP 用此方式读取子应用文档 |
| 登录用户 | `account` 的 user |

注册条件（任一不满足则不注册，访问返回 404）：

| 条件 | 说明 |
| --- | --- |
| `openApi` 不为 `false` | 显式关闭时不注册 |
| `openApi.getAuthenticate()` 返回非空数组 | 默认宿主未注册 `fastify.account` 时返回 `null` |
| 宿主已注册 `@fastify/swagger` | 存在 `fastify.swagger`；有鉴权但缺少 swagger 时打 warn 日志 |

> **注意**：`@fastify/swagger` 通过 `onRoute` 钩子收集路由，只能收集到它之后定义的路由，须在 `server.js` 最前面注册；本插件不注册 swagger，宿主需自行安装。

```js
// server.js：在注册其它插件与路由之前注册 @fastify/swagger
fastify.register(require('@fastify/swagger'), {
  openapi: {
    info: { title: packageJson.name, version: packageJson.version }
  }
});

// ...@kne/fastify-sequelize、@kne/fastify-account、业务模块

fastify.register(require('@kne/fastify-app-runtime'), {
  root: path.join(__dirname, './build'),
  packageJson
});
```

```json
{
  "openapi": "3.0.3",
  "info": { "title": "ai-interview-flowup", "version": "0.1.194" },
  "paths": {
    "/health": { "get": { "summary": "存活检查" } }
  }
}
```

#### 前端托管

| 请求 | 行为 |
| --- | --- |
| `GET {prefix}` 下存在的文件 | 由 `@fastify/static` 返回 |
| `GET {prefix}` | 返回入口 HTML |
| 其它未匹配的 GET | 返回入口 HTML（`static.fallback` 为 `true` 时） |
| 其它未匹配的非 GET | 404 |

### 程序化 API

挂载于 `fastify[name].services`：

| 方法签名 | 说明 |
| --- | --- |
| `getEnv()` | 当前环境 |
| `getOrigin()` | 去掉末尾 `/` 的 origin，未配置为空字符串 |
| `getEntry()` | 当前入口 HTML 文件名 |
| `getRemoteModuleConfig()` | 补全后的远程组件配置，文件不存在返回 `null` |
| `getAppConfig()` | `{ runtime, settings }` |
| `getHealth()` | `/health` 返回内容 |
| `checkReady()` | `{ status, checks }` |

挂载于 `fastify[name].utils`：

| 方法签名 | 说明 |
| --- | --- |
| `getRemoteModuleConfigFile(entry)` | 入口文件名 → 远程组件配置文件名 |
| `resolveConfigUrl(url, origin)` | 补全远程组件 url |
| `withTimeout(task, ms)` | 带超时执行，超时错误 `code` 为 `TIMEOUT` |
| `sendJson(reply, { statusCode, data, cors })` | 以流返回 JSON |
| `verifyServiceToken(oidc, request, scope)` | 校验请求是否携带本应用 audience、含指定 scope 的 OIDC client 令牌 |

### 机制说明

| 机制 | 说明 |
| --- | --- |
| 依赖声明 | 插件名 `fastify-app-runtime`，依赖 `fastify-sequelize`，未先注册时启动报错 |
| OpenAPI 文档 | 依赖宿主提前注册的 `@fastify/swagger` 与 `fastify.account`，在注册本插件时判断，须先于本插件注册 |
| 建表 | `@kne/fastify-setting` 的设置表随 `fastify.sequelize.sync()` 创建，须在 sync 之前注册本插件 |
| 版本兼容 | `@fastify/static`、`fastify-plugin` 为 peer 依赖，沿用业务项目已安装版本（fastify 4 / 5） |
