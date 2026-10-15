# fastify-app-runtime

### 描述

Fastify 应用运行时插件：前端托管、remote-module-config.json、健康检查与应用设置

### 关键词

fastify, fastify-plugin, remote-module-config, module-federation, health-check, readiness, app-config, static, spa

### 安装

```shell
npm i --save @kne/fastify-app-runtime
```

### 概述

#### 项目概述

`@kne/fastify-app-runtime` 是业务应用后端的统一运行时插件，把各项目在 `server.js` 里各写一份的前端托管逻辑收拢到一处，并提供跨系统共用的几类公开接口：

| 能力 | 说明 |
| --- | --- |
| 前端托管 | 托管 `build` 目录，按环境选择入口 HTML，未匹配的 GET 路由回落到入口页 |
| 远程组件配置 | `GET /remote-module-config.json`，供宿主用 `@kne/remote-loader` 的 `configUrl` 加载本应用的远程组件 |
| 健康检查 | `GET /health` 存活检查、`GET /ready` 就绪检查（数据库 + 自定义检查） |
| 应用设置 | `GET /app-config.json` 返回运行信息与 `@kne/fastify-setting` 中已启用的设置项 |
| OpenAPI 文档 | `GET /open-api.json` 返回宿主 `@fastify/swagger` 收集的文档，需管理员权限；宿主无 `account` 模块时不开启 |

> **关键设计**：入口 HTML 与 `remote-module-config*.json` 由同一个 `getEntry` 决定，文件名映射规则与 `@kne/npm-tools entryHtml` 一致，构建产物与服务端读取不会错位。

#### 核心架构与流程

```
宿主 / 浏览器 / 探针
        ↓
  Fastify（业务应用）
        ├→ @kne/fastify-sequelize（须先注册）
        └→ @kne/fastify-app-runtime
             ├→ @kne/fastify-setting（内部注册，setting 参数透传）
             ├→ GET /remote-module-config.json ─→ build/remote-module-config{后缀}.json（按入口推导）
             ├→ GET /health
             ├→ GET /ready ─→ sequelize.authenticate() + readyChecks（并行、各自超时）
             ├→ GET /app-config.json ─→ runtime + setting.services.detail()
             ├→ GET /open-api.json ─→ fastify.swagger()（需 account.admin；无 account 或 swagger 时不注册）
             └→ @fastify/static(build) + NotFound 回落入口页（static 为 false 时不注册）
```

| 节点 | 说明 |
| --- | --- |
| 入口选择 | `getEntry({ env, config })`，默认 `staging → entry.html`、`prod → entry-prod.html`、其它 `index.html` |
| 配置文件 | `entry{后缀}.html` / `index{后缀}.html` → `remote-module-config{后缀}.json` |
| 公开接口 | 均挂在根路径，默认带 `Access-Control-Allow-Origin: *`，以流返回避免被 `@kne/fastify-response-data-format` 包装 |

#### 核心概念详解

##### 启动不依赖构建产物与外部服务

所有文件读取与依赖检查都发生在请求时：

| 情况 | 行为 |
| --- | --- |
| `build` 目录或入口文件不存在 | 正常启动；入口页与回落返回 404 |
| `remote-module-config*.json` 不存在 | `/remote-module-config.json` 返回 404 |
| 数据库不可用 | `/health` 仍为 200；`/ready` 返回 503 |
| 读取设置失败或超时 | `/app-config.json` 仍为 200，`settings` 为 `null` |

##### 存活与就绪

`/health` 只表示进程可响应，适合作为部署平台的存活探针（如 `@kne/fastify-app-manager` 的 `healthCheckPath`）；`/ready` 检查数据库与自定义依赖，适合作为摘流 / 就绪探针。就绪检查失败只返回 `error` / `timeout`，具体错误写入日志，不返回给调用方。

##### 应用设置的公开范围

`settings` 即 `@kne/fastify-setting` 的 `services.detail()`：所有 `status` 为 `open` 的设置项，再合并注册时传入的 `setting.setting` 固定值。该数据与 `{setting.prefix}/detail` 一样公开，**不要在设置表中存放密钥**。

#### 主要特性

| 特性 | 说明 |
| --- | --- |
| 统一入口规则 | 默认遵循应用中心部署规范的 `ENV` 入口约定，可用 `getEntry` 覆盖（如按 `LANDSCAPE` 区分） |
| URL 补全 | 配置中 `url` 为空或相对路径时以 `origin` 补全，绝对地址保持不变 |
| 不被响应包装 | 公开接口以流返回，宿主注册的 `{ code, data }` 包装钩子不生效 |
| 跨域 | 默认 `Access-Control-Allow-Origin: *`，`cors: false` 关闭 |
| 兼容多版本 | `@fastify/static`、`fastify-plugin` 为 peer 依赖，沿用业务项目已安装的版本 |

#### 使用方法

```js
// server.js：先注册 @fastify/env 与 @kne/fastify-sequelize，再注册本插件（须在 sequelize.sync() 之前）
fastify.register(require('@kne/fastify-app-runtime'), {
  root: path.join(__dirname, './build'),
  packageJson: require('../package.json'),
  setting: {
    prefix: '/api/v1/setting'
  }
});
```

按 `LANDSCAPE` 区分入口、使用自定义 origin 变量并追加就绪检查：

```js
fastify.register(require('@kne/fastify-app-runtime'), {
  root: path.join(__dirname, './build'),
  packageJson: require('../package.json'),
  origin: fastify.config.ORIGIN_HOST,
  getEntry: ({ env, config }) => (env !== 'local' ? `entry-${config.LANDSCAPE}-${env}.html` : 'index.html'),
  static: { prefix: '/company' },
  setting: {
    prefix: '/api/v1/setting',
    setting: { systemType: fastify.config.SYSTEM_TYPE }
  },
  readyChecks: {
    redis: () => redis.ping()
  }
});
```


### 示例

### API

#### 配置项

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
| openApi.getAuthenticate | function | 否 | `fastify.account` 的 user + admin | 返回 `onRequest` 鉴权数组；返回空值或空数组时不注册接口 |

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

#### 接口

以下接口均挂在根路径（`openApi.path` 可自定义），返回原始 JSON（不经 `{ code, data }` 包装），带 `Cache-Control: no-cache` 与 `cors` 指定的跨域头。

##### GET /remote-module-config.json

按当前入口读取构建产物中的远程组件配置，`url` 为空或相对路径时以 `origin` 补全。文件不存在返回 404。

```json
{
  "name": "ai-interview-flowup",
  "url": "https://cdn.example.com/ai-interview-flowup/cn-staging/adf8e0d",
  "tpl": "{{url}}",
  "version": "0_1_194"
}
```

##### GET /health

进程存活即返回 200，不检查外部依赖。

```json
{ "status": "ok", "name": "ai-interview-flowup", "version": "0.1.194", "uptime": 3600 }
```

##### GET /ready

并行执行就绪检查：已注册 `fastify-sequelize` 时自动包含 `database`（`sequelize.authenticate()`），再加上 `readyChecks`。全部通过返回 200，任一失败返回 503；单项结果为 `ok`、`error` 或 `timeout`，错误详情只写日志。

```json
{ "status": "error", "checks": { "database": "ok", "redis": "timeout" } }
```

##### GET /app-config.json

返回运行信息与已启用的设置项。读取设置失败或超时时 `settings` 为 `null`，接口仍返回 200。

```json
{
  "runtime": { "name": "ai-interview-flowup", "version": "0.1.194", "env": "staging", "origin": "https://staging.example.com" },
  "settings": { "systemType": "saas", "siteTitle": { "zh": "演示系统" } }
}
```

##### GET /open-api.json

返回 `@fastify/swagger` 收集的当前系统 OpenAPI 文档（即 `fastify.swagger()`），默认需要 `account` 的 user + admin 鉴权，未通过返回 401。

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

##### 前端托管

| 请求 | 行为 |
| --- | --- |
| `GET {prefix}` 下存在的文件 | 由 `@fastify/static` 返回 |
| `GET {prefix}` | 返回入口 HTML |
| 其它未匹配的 GET | 返回入口 HTML（`static.fallback` 为 `true` 时） |
| 其它未匹配的非 GET | 404 |

#### 程序化 API

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

#### 机制说明

| 机制 | 说明 |
| --- | --- |
| 依赖声明 | 插件名 `fastify-app-runtime`，依赖 `fastify-sequelize`，未先注册时启动报错 |
| OpenAPI 文档 | 依赖宿主提前注册的 `@fastify/swagger` 与 `fastify.account`，在注册本插件时判断，须先于本插件注册 |
| 建表 | `@kne/fastify-setting` 的设置表随 `fastify.sequelize.sync()` 创建，须在 sync 之前注册本插件 |
| 版本兼容 | `@fastify/static`、`fastify-plugin` 为 peer 依赖，沿用业务项目已安装版本（fastify 4 / 5） |
