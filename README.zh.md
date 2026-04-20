# lonesome-js

基于 Pingora 的 Node.js 高性能可编程反向代理绑定。

[English README](./README.md)

## 为什么使用 lonesome-js

- 基于 Pingora，具备现代异步代理的性能与稳定性基础。
- 通过 `addOrUpdate` 支持 Node.js 运行时路由热更新，无需重启进程。
- 路由匹配与中间件条件由 CEL 表达式驱动。
- 提供 `virtual_js` upstream，可在进程内接入 Node.js 处理链路。

## 与传统反向代理的设计差异

多数传统反向代理偏向静态配置文件与 reload 流程；`lonesome-js` 更偏向运行时 API 与可编程流量编排。

### 基于 CEL 的匹配与逻辑表达

路由规则、中间件条件和动态值都可以通过 CEL 表达式描述，而不是只能依赖固定指令。

示例：
- 路由匹配：`"Method('POST') && PathPrefix('/api') && Query('debug', '1')"`
- 条件中间件：`rule: "Header('x-env', 'prod')"`
- 动态值：`expression: "MethodValue() + '-' + QueryValue('id')"`

### `virtual_js` 上游能力

除 TCP/Unix socket upstream 外，`virtual_js` 可以把请求桥接到进程内 JavaScript handler。适合构建内部适配层或可编程后端，无需额外暴露网络端口。

## 快速开始

### 1. 安装

```bash
npm i lonesome-js
```

> Windows 预编译绑定暂不可用，建议临时使用 WSL。

### 2. 启动代理服务

```ts
import { LonesomeServer } from 'lonesome-js'

const server = new LonesomeServer()

server.start({
  listeners: [{ kind: 'tcp', addr: '127.0.0.1:8080' }],
})
```

### 3. 添加基础路由

```ts
server.addOrUpdate({
  id: 'basic-proxy',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [],
  upstreams: [
    { kind: 'tcp', address: '127.0.0.1:9000', tls: false, sni: '', weight: 1 },
  ],
  loadBalancer: { algorithm: 'round_robin' },
})
```

### 4. 运行时热更新路由

```ts
server.addOrUpdate({
  id: 'basic-proxy',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [{ type: 'respond', config: { status: 418, body: 'teapot' } }],
  upstreams: [
    { kind: 'tcp', address: '127.0.0.1:9000', tls: false, sni: '', weight: 1 },
  ],
})
```

## 文档

以下 `docs/` 文档当前为英文：

- 文档总览与 LonesomeServer 控制 API: [docs/readme.md](./docs/readme.md)
- 路由管理与热更新: [docs/route.md](./docs/route.md)
- CEL 表达式: [docs/cel.md](./docs/cel.md)
- `virtual_js` upstream: [docs/virtual_js.md](./docs/virtual_js.md)
- 中间件：*TODO*
