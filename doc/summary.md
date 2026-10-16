### 项目概述

`@kne/fastify-app-runtime` 是业务应用后端的统一运行时插件，把各项目在 `server.js` 里各写一份的前端托管逻辑收拢到一处，并提供跨系统共用的几类公开接口：

| 能力 | 说明 |
| --- | --- |
| 前端托管 | 托管 `build` 目录，按环境选择入口 HTML，未匹配的 GET 路由回落到入口页 |
| 远程组件配置 | `GET /remote-module-config.json`，供宿主用 `@kne/remote-loader` 的 `configUrl` 加载本应用的远程组件 |
| 健康检查 | `GET /health` 存活检查、`GET /ready` 就绪检查（数据库 + 自定义检查） |
| 应用设置 | `GET /app-config.json` 返回运行信息与 `@kne/fastify-setting` 中已启用的设置项 |
| OpenAPI 文档 | `GET /open-api.json` 返回宿主 `@fastify/swagger` 收集的文档，需登录用户或带 `open-api:read` 的 OIDC 服务令牌（应用中心 MCP 使用）；宿主无 `account` 模块时不开启 |

> **关键设计**：入口 HTML 与 `remote-module-config*.json` 由同一个 `getEntry` 决定，文件名映射规则与 `@kne/npm-tools entryHtml` 一致，构建产物与服务端读取不会错位。

### 核心架构与流程

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
             ├→ GET /open-api.json ─→ fastify.swagger()（需登录用户或 OIDC 服务令牌；无 account 或 swagger 时不注册）
             └→ @fastify/static(build) + NotFound 回落入口页（static 为 false 时不注册）
```

| 节点 | 说明 |
| --- | --- |
| 入口选择 | `getEntry({ env, config })`，默认 `staging → entry.html`、`prod → entry-prod.html`、其它 `index.html` |
| 配置文件 | `entry{后缀}.html` / `index{后缀}.html` → `remote-module-config{后缀}.json` |
| 公开接口 | 均挂在根路径，默认带 `Access-Control-Allow-Origin: *`，以流返回避免被 `@kne/fastify-response-data-format` 包装 |

### 核心概念详解

#### 启动不依赖构建产物与外部服务

所有文件读取与依赖检查都发生在请求时：

| 情况 | 行为 |
| --- | --- |
| `build` 目录或入口文件不存在 | 正常启动；入口页与回落返回 404 |
| `remote-module-config*.json` 不存在 | `/remote-module-config.json` 返回 404 |
| 数据库不可用 | `/health` 仍为 200；`/ready` 返回 503 |
| 读取设置失败或超时 | `/app-config.json` 仍为 200，`settings` 为 `null` |

#### 存活与就绪

`/health` 只表示进程可响应，适合作为部署平台的存活探针（如 `@kne/fastify-app-manager` 的 `healthCheckPath`）；`/ready` 检查数据库与自定义依赖，适合作为摘流 / 就绪探针。就绪检查失败只返回 `error` / `timeout`，具体错误写入日志，不返回给调用方。

#### 应用设置的公开范围

`settings` 即 `@kne/fastify-setting` 的 `services.detail()`：所有 `status` 为 `open` 的设置项，再合并注册时传入的 `setting.setting` 固定值。该数据与 `{setting.prefix}/detail` 一样公开，**不要在设置表中存放密钥**。

### 主要特性

| 特性 | 说明 |
| --- | --- |
| 统一入口规则 | 默认遵循应用中心部署规范的 `ENV` 入口约定，可用 `getEntry` 覆盖（如按 `LANDSCAPE` 区分） |
| URL 补全 | 配置中 `url` 为空或相对路径时以 `origin` 补全，绝对地址保持不变 |
| 不被响应包装 | 公开接口以流返回，宿主注册的 `{ code, data }` 包装钩子不生效 |
| 跨域 | 默认 `Access-Control-Allow-Origin: *`，`cors: false` 关闭 |
| 兼容多版本 | `@fastify/static`、`fastify-plugin` 为 peer 依赖，沿用业务项目已安装的版本 |

### 使用方法

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
