# AGENTS.md — wecom-email-screenshot

## 项目概述

Cloudflare Worker 应用：接收 WooCommerce 订单创建 webhook → 通过 IMAP 读取企业邮箱中的未读订单邮件 → 截图 → 推送到企业微信群（群机器人 / 自建应用消息）。推送成功后标记邮件已读，避免重复处理。

## 技术栈

- **运行时**：Cloudflare Workers（ES Module 格式，`export default { fetch }`）
- **关键绑定**：`[browser] binding = "BROWSER"`（Browser Rendering API，需付费版）
- **Socket**：`cloudflare:sockets`（IMAP over TLS，**不使用** `nodejs_compat`）
- **无外部依赖**：除 `wrangler` 外不依赖任何 npm 包；不使用 `node:net`

## 目录结构

```
src/
├── index.js       Worker 入口，请求编排（鉴权→IMAP→截图→推送→标记已读）
├── imap.js        IMAP 客户端（cloudflare:sockets，RFC 3501 子集）
├── eml.js         EML/MIME 解析器（提取 subject/from/date/html/text）
├── screenshot.js  截图引擎（Browser Rendering | 第三方 API 多 key 轮询）
├── wecom.js       企业微信推送（群机器人 webhook + 自建应用消息）
└── utils.js       公共工具（日志、重试、串行队列、splitList、json 响应）
test/
├── eml.test.js    EML 解析器断言测试（5 个用例）
└── sample-order.json  WooCommerce webhook 示例请求体
```

## 常用命令

```bash
mise exec -- npm install          # 安装依赖
mise exec -- npx wrangler dev     # 本地开发
mise exec -- npx wrangler deploy  # 部署
mise exec -- npx wrangler deploy --dry-run  # 验证打包（不部署）
node --check src/index.js         # 单文件语法检查（6 个文件逐一检查）
node test/eml.test.js             # EML 解析器测试
```

**package.json 的 `check` 脚本只检查 4 个文件**，手动检查时应覆盖全部 6 个：
`src/{index,imap,wecom,eml,screenshot,utils}.js`

## 架构边界与编辑规则

### 模块依赖方向
```
index.js → imap.js / wecom.js / eml.js / screenshot.js / utils.js
wecom.js → utils.js
screenshot.js → utils.js
imap.js → cloudflare:sockets（无内部依赖）
eml.js（无依赖，纯函数）
utils.js（无依赖，纯函数）
```
**禁止反向依赖**：`utils.js` 不得 import 任何其他 src 模块。

### IMAP 连接约束
- 同一 IMAP 连接上的命令**必须串行**，并发会破坏协议
- `markSeen` 通过 `createSerialQueue()`（`utils.js`）串行化
- `fetchMessage` 和 `searchUnread` 在 `handleAuto` 中串行执行，不可并发

### 截图引擎切换
通过 `env.SCREENSHOT_MODE` 切换：`'browser'`（默认）| `'api'`
- `browser`：调用 `env.BROWSER`（Puppeteer API）
- `api`：HTTP GET 请求第三方 API，支持 `{key}` / `{html}` 占位符，15s 超时，多 key 故障转移
- 新增截图模式时在 `screenshotEmail` 中添加分支

### 推送通道
- 群机器人：`WEBHOOK_KEY` 非空即启用；图片 base64+md5（≤2MB），@群员需追加 text 消息
- 自建应用：`WECOM_CORP_ID` + `WECOM_AGENT_ID` 同时填写即启用；流程为 gettoken → media/upload → message/send
- 两通道可并存，但用户确认实际不会同时启用

### 重试机制
`retryWithBackoff(fn, options)` 参数为**对象**：`{ maxRetries, baseDelayMs, backoffFactor, onRetry }`
- `FormData` 等 body-stream 对象必须在重试闭包**内部**创建（stream 只能消费一次）

## 编码约定

- **语言**：代码注释用简体中文，git commit 用英文
- **ES Module**：所有 import 使用相对路径（`'./utils.js'`），**不带** `node:` 前缀
- **import 位置**：统一在文件顶部，不得放在文件中间
- **日志**：使用 `utils.js` 的 `log(level, message, data)`，不直接 `console.log`；通过 `LOG_LEVEL` 环境变量控制级别
- **响应**：使用 `utils.js` 的 `json(obj, status)` 工具函数
- **函数长度**：原则不超过 50 行，超过应拆分
- **无类型注解**：纯 JavaScript，不使用 TypeScript

## 环境变量

非敏感配置写在 `wrangler.toml` 的 `[vars]` 中；敏感信息用 `wrangler secret put` 设置：
- `IMAP_PASSWORD`：邮箱密码
- `WECOM_CORP_SECRET`：自建应用 secret
- `AUTH_TOKEN`：接口鉴权 token（WooCommerce webhook 的 Secret）

## 已知限制

- Workers 免费版**无法**使用 Browser Rendering（需付费版）
- `cloudflare:sockets` 不需要 `nodejs_compat` 兼容标志
- Workers 的 SubtleCrypto **不支持 MD5**，webhook 图片校验用 `wecom.js` 中的纯 JS MD5 实现
- 群机器人图片消息 ≤2MB（`screenshot.js` 超限时自动降采样重试）
- 群机器人频率上限 20 条/分钟；自建应用单成员 30 次/分钟

## 敏感区域

修改以下文件前应充分理解上下文：
- **`src/imap.js`**：IMAP 协议实现，literal 读取（`{N}` 声明长度精确截取）和标签式响应是核心逻辑，改动需同步更新并发安全分析
- **`src/eml.js`**：MIME 解析递归逻辑，`test/eml.test.js` 有 5 个覆盖性测试用例，改动后必须跑测试
- **`src/wecom.js`**：MD5 实现（纯 JS），企业微信 API 的 errcode 校验逻辑
