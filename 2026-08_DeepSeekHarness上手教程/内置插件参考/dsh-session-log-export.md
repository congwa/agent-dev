# session-log-export

> `@deepseek-ai/dsh-session-log-export` · bundle：`web-app` · 配置树 id：`session-log-download` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：Web 端的"把这个会话打包下载"控件——宿主侧只注册一个 `/export` 命令，浏览器侧提供 Session Header 上的按钮、一个下载控制器和一个共享弹窗；ZIP 本身由 `dsh-host-apiproxy` 的下载端点流式产出。

## 它在树上长什么样

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

出处 `packages/bundle/web-app/cordis.patch.yml:70-71`（上一行注释：``Browser Session export: `/export` command plus the shared download dialog.``）。**无 config、无 inject 行**：宿主半边自己声明 `export const inject = ['commands']`（`packages/session-query/session-log-export/src/index.ts:7`），浏览器半边声明 `export const inject = ['slots', 'locale']`（`src/client/index.ts:26`），浏览器侧的包依赖清单写在 package.json 的 `dsh.client.inject`（`package.json:54-59`，`platform: web` 在 `60`）。这是一个**双面包**：一行 YAML 同时挂宿主插件和浏览器插件。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 命令（宿主） | `/export` | `description: 'Download this Session log as a ZIP archive'`；handler 只返回结果，不做 IO（`src/index.ts:19-25`） |
| service（浏览器） | `ctx.sessionLogDownload` | `SessionLogDownloadController`，`ctx.provide('sessionLogDownload', controller)`（`src/client/index.ts:33-34`） |
| 事件监听（浏览器） | `command/executed`（emit） | `commandName === 'export' && result.kind === 'success'` 时触发下载（`src/client/index.ts:37-39`）；该事件模式在 `packages/client/ui-commands/src/client/service.ts:36` 标注 `@mode emit` |
| UI slot | `conversation.session.header.utilities` | 注册 id 为 `session-log-download` 的 Header 按钮 + 弹窗（`src/client/index.ts:40-49`、`src/client/HeaderAction.tsx:16-30`）；按钮尺寸是 `min-width: 111px` / `height: 32px`（`src/client/HeaderAction.module.css:5-6`，README 写作 "a 111×32 `Session log` action"，实为最小宽度） |
| i18n | 命名空间 `session-log-download` | zh / en 两套词典（`src/client/index.ts:36`，`NS` 定义在 `src/client/locales.ts:2`） |
| invariant | 包名占位 | 空实现：命令注册表管生命周期配对，ZIP 完整性归 ApiProxy（`src/invariant.ts:12-13`） |

本插件**不监听任何会话事件**，也不注册工具或 prompt 段。

## 配置项

无配置项。行为由两处决定：宿主端点的行为归 `dsh-host-apiproxy`（压缩级别 `sessionExportCompressionLevel` 0–9，默认 6，是那个包的配置——`packages/host/apiproxy/src/index.ts:50-55`、`packages/host/apiproxy/src/session-export.ts:33`），浏览器端的 URL 是写死的 `/api/session.export?sessionId=<id>&includeDescendants=true`（`src/client/controller.ts:114-116`），文件名固定为 `dsh-session-<清洗过的id>.zip`（`src/client/controller.ts:30-32`）。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/export` | 返回 `Session log download requested.`，提交的那个浏览器随后发起下载（`src/index.ts:9-12`、`22-23`） |
| `/export <path>` | 报错 `The Web /export command does not accept a path.`——浏览器下载的落点由浏览器自己决定（`src/index.ts:24`） |

两条入口（Header 按钮 / 斜杠命令）走同一个 controller：先发 `HEAD` 预检，非 2xx 就把 `Export failed: HTTP <status>` 连同 body 文本抛成错误；通过后把 GET URL 交给浏览器下载管理器，**JS 里从不缓冲 ZIP**（`src/client/controller.ts:111-130`、`39-44`）。同一会话的并发点击共享同一次操作（`src/client/controller.ts:78-88`）；插件卸载时 abort 预检并等待收敛（`src/client/controller.ts:104-109`）。

## 模型看得见什么

README《Model Experience》："Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history." Token effect "Zero. The command creates no model turn."（`README.md:35`、`39`）

## 什么时候你会想换掉它 / 怎么换

- **不想给用户导出入口**：把这一行删掉或 `disabled: true`。宿主端点属于 `dsh-host-apiproxy`，**仍然开着**——真要封死得动那个包，不是这一行。
- **只留斜杠命令、不要按钮**：得改浏览器半边的 slot 注册，配置层没有开关。
- **非 Web 形态想导出**：本包只在 web-app bundle 挂载（`README.md:14`；其余 bundle 无此行），headless / TUI 没有它；那些形态直接读 `$DSH_HOME/sessions` 下的 JSONL 更直接（见 base 行 `session-persistence-jsonl`，`packages/bundle/base/cordis.patch.yml:98-101`）。

## 坑与边界

- README《Known Limitations》：端点要求持久化后端提供**每会话原始工件**——JSONL 后端支持明文与 zstd，**SQLite 导出不含在内**；这是浏览器下载不是宿主写文件，返回不了本地路径；预检只能发现"流开始之前"的失败，后代会话或附件在 GET 被接受之后出问题只会由浏览器下载管理器报出来（`README.md:47-49`）。
- 关掉弹窗**不会**取消在飞的下载，之后那次操作结算也不会把弹窗弹回来（`README.md:18`、`src/client/controller.ts:94-98`；结算时沿用当前 `open` 状态见 `123-128`）。
- 斜杠触发时宿主会先跨 `SessionStore.flush` 屏障再读原始工件，所以 ZIP 里含触发它的那对 `command/run` / `command/done`（`README.md:16`、`packages/host/apiproxy/src/api-proxy.ts:3665-3666`）。
- **ZIP 里是逐字原文**：`readRaw` 给的是持久化字节本身，不是从解析后事件重建的——用户消息、工具输出、文件内容、system prompt 全在里面，还包含 `subagents/<id>/` 下的子代理日志和 `media/<attachmentId>.<ext>` 下的图片（`packages/host/apiproxy/README.md:31`，路径构造见 `packages/host/apiproxy/src/session-export.ts:108`、`250`）。这与 [session-telemetry-otel](./dsh-session-telemetry-otel.md) 上报的是同一份内容，区别只在"发给谁"；`session/title` 与 `session/title-llm-request`（见 [session-title](./dsh-session-title.md)、[session-title-first-prompt-llm](./dsh-session-title-first-prompt-llm.md)）也一并在内。
- 端点是 fail-loud 的：缺服务 500、后端不支持原始工件 501、根会话不存在 404、后代缺工件或图片读不出则整个流失败——**绝不静默少导出**（`packages/host/apiproxy/src/api-proxy.ts:3645-3676`、`packages/host/apiproxy/README.md:31`）。
