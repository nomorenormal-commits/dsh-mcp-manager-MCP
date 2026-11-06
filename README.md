# dsh-mcp-manager

**DSH（DeepSeek Harness）的 MCP 服务管理器。** 在设置页里集中添加、启停、配置 MCP 服务，自动检测掉线，查看连接事件日志，一键导入 / 导出配置。

> 官方 `@deepseek-ai/dsh-mcp-client` 负责“连”，这个插件负责“管”。不改动官方插件，只读写 profile 的 `cordis.patch.yml`，并复用官方 loader 的热挂载能力。

## 特性

| 能力 | 说明 |
| --- | --- |
| 可视化服务列表 | 汇总 profile 里所有 MCP 条目，托管 / 外部条目区分展示，状态灯一眼可见 |
| 添加与编辑 | stdio（command / args / env / cwd）与 Streamable HTTP（url / headers）两种接入方式，含常用模板 |
| 一键启停 | 写 loader 条目即时生效；同时落盘到 `cordis.patch.yml`，重启后仍保持 |
| 掉线检测 | 30s 轮询：fiber 运行态 + HTTP 可达性探测；状态变化写入事件日志 |
| 日志查看 | 每个服务独立的时间线：配置变更、启停、探测结果、掉线 / 恢复迁移 |
| 一键导入 / 导出 | 支持本插件格式与 Claude Desktop 的 `mcpServers` 格式；导出可选自动打码密钥 |
| 安全 | 复用 DSH 的 `connection.requestRejection` 信任栅栏；只监听本机路由 |

## 安装

需要 DSH `>= 0.1.2`（Web 界面 / Desktop 均可；插件同时挂 Host 与 Client 两半）。

从本地目录安装（开发 / 试用）：

```sh
dsh plugin --profile desktop add link:"C:\path\to\dsh-mcp-manager"
```

从 GitHub 安装（仓库发布后）：

```sh
dsh plugin --profile desktop add github:<owner>/dsh-mcp-manager
```

安装后重启 DSH（或等 loader 热加载），打开 **设置 → MCP 服务**。

> 如果安装后设置页没有出现入口：确认 profile 的 `package.json` 的 `dependencies` 里有 `dsh-mcp-manager`，且 `dsh.profile.bundles` 里包含它；部分 DSH 版本需要手动把包名加进 bundles 数组。

## 使用

- **添加服务**：右上角「＋ 添加服务」。可从模板（Filesystem / GitHub / Fetch）起步，或手填。
- **服务名称**：会变成工具名前缀 `mcp__<名称>__<工具>`，只允许字母、数字、`_`、`-`，长度 1–32。
- **启停**：卡片右侧开关。停用的服务保留配置但不加载、不消耗 token。
- **检测**：HTTP 服务做一次可达性探测（任何 HTTP 响应都算端口活着）；stdio 由官方客户端托管，无法从外部探测，只看运行态。
- **重连**：对已加载条目执行 `fiber.restart()`，用于配置改错或进程卡死后的手动恢复。
- **日志**：展开卡片查看该服务的管理器事件时间线。
- **导入 / 导出**：导出默认打码 `TOKEN / KEY / PASSWORD / AUTHORIZATION` 一类字段；导入支持 `merge`（同名覆盖）与 `replace`（清掉全部托管服务后重建）。

## 服务状态语义

| 状态 | 含义 |
| --- | --- |
| 在线 | 条目 fiber `ACTIVE`；HTTP 服务最近一次探测可达 |
| 掉线 | fiber `FAILED`，或 HTTP 探测连接失败 / 超时 |
| 未加载 | 托管配置已落盘，但当前 loader 里没有对应条目（通常是刚手改过 patch，等重启） |
| 连接中 | fiber `PENDING / LOADING / UNLOADING` |
| 已停用 | 条目 `disabled: true`，不加载 |

**关于 stdio 掉线的边界**：stdio 子进程由官方 `dsh-mcp-client` 拉起并自动重连，子进程的 stderr 不经过本插件，管理器也无法安全地从外部探测它。因此 stdio 的“掉线”以 fiber 运行态为准；进程内部的断线重连由官方客户端负责。HTTP 服务则额外做真实可达性探测。

## 数据落盘

| 文件 | 作用 |
| --- | --- |
| `<profile>/cordis.patch.yml` | 托管区块（`# >>> dsh-mcp-manager managed block` 到 `# <<<` 之间）写服务行；块外的用户配置原样保留 |
| `<profile>/.dsh-mcp-manager/state.json` | 管理器的写入模型：服务、启停状态、外部条目覆盖行 |
| `<profile>/cordis.patch.yml.dsh-mcp-manager.bak` | 每次写入前的上一版备份 |

写入策略：**先落盘，再热加载**。落盘失败会中止操作；热加载失败则保留配置并在界面上提示，重启后仍能生效。每次写入 patch 前都会做标记完整性检查，标记只出现一半时拒绝写入，避免损坏用户文件。

## 外部条目（非本管理器创建）

已经手写在 `cordis.patch.yml` 的 `@deepseek-ai/dsh-mcp-client` 行会被识别为「外部」：

- 只读展示，不能编辑 / 删除（避免误改用户原始配置）；
- 可以启停：停用会写一条 `- id: <原条目 id> / disabled: true` 的覆盖行，启用时移除覆盖行；
- 覆盖行追加在文件末尾，因此对它**之前**的外部行生效；若外部行在托管块之后，请把它移到托管块之前。

## 导入 / 导出格式

本插件导出：

```json
{
  "format": "dsh-mcp-manager/export",
  "version": 1,
  "exportedAt": "2026-11-06T00:00:00.000Z",
  "servers": [
    {
      "serverName": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "***" },
      "toolCallTimeoutMs": 60000,
      "failOnStartupError": false,
      "external": false
    }
  ]
}
```

导入同时兼容 Claude Desktop：

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer x" } }
  }
}
```

## 安全说明

- 所有路由都过 DSH 的 `connection.requestRejection`，拒绝跨站 / 非受信来源。
- 仅监听本机，不申明公网访问。
- 服务配置（含 env / headers 中的密钥）会写进当前用户的 profile 目录；导出时默认打码，需要完整密钥时手动取消勾选。
- 删除操作只删托管行，不触碰块外内容。

## 开发

```sh
npm test              # node:test：配置校验 / patch 渲染 / HTTP 路由集成
npm run pack:check    # 检查发布包内容
```

无运行时依赖，只用 Node 内置模块；Client 半侧是手写的 `__ModuleLoader__` bundle，不需要构建步骤。

目录：

```
index.js        Host 半侧：loader 读写 + HTTP API + 看门狗
client.js       设置页 UI（手写 ModuleLoader bundle）
lib/config.js   配置校验 / 脱敏 / 导入导出（纯函数）
lib/patch.js    托管区块渲染与合并（纯函数）
lib/profile.js  profile 定位 / 状态文件 / patch 原子写入
lib/health.js   HTTP 可达性探测
lib/log.js      事件日志环形缓冲
test/           单元测试 + 假 ctx 的接口集成测试
```

## License

MIT
