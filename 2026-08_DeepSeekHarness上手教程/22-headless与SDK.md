# 22 · headless 与 SDK

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章讲不开 Web UI 的四条路：一次性 CLI、JSON-RPC 运行时、Python SDK、ACP；外加把 dsh 当库嵌进自己的程序，以及 `BENCHMARK.md` 推荐的评测跑法。

**读完这章你会**：

- 用 `dsh --profile headless "任务"` 跑一次性任务，并按退出码判断成败
- 起一个 JSON-RPC 运行时，读懂它的 3 个请求 / 4 个通知，自己写客户端
- 用 Python SDK 在脚本里驱动 agent，并换成自己的 `cordis.yml`
- 用 ACP 把 dsh 挂到别的 agent 客户端 / 父 agent 下面
- 用 `boot()` 把整棵插件树嵌进自己的 Node 程序
- 按 BENCHMARK 的口径跑批量评测（每任务独立 workspace 与 session id）

## 1. 先选路：四条路各自解决什么问题

| 路 | 入口 | 进程形态 | stdout 是什么 | 谁驱动回合 |
|---|---|---|---|---|
| 一次性 CLI | `dsh --profile headless "job"` | 跑完即退 | 最后一条 assistant 文本 + `\n` | dsh 自己 |
| JSON-RPC 运行时 | `dsh-jsonrpc-agent <cordis.yml>` | 常驻，stdio | **只有** JSON-RPC 帧 | 你的客户端 |
| Python SDK | `deepseek-harness-sdk` | 拉起上面那条运行时当子进程 | 由你的脚本决定 | 你的 Python 代码 |
| ACP | `dsh-acp-demo [--config …]` | 常驻，stdio | **只有** ACP JSON-RPC 帧 | 支持 ACP 的客户端 |

JSON-RPC 在这里就是"一行一条 JSON 消息"的远程调用约定：请求带 `id`+`method`，响应只带 `id`，通知只带 `method`（`packages/sdk/protocol/README.md:9`）。

两条服务端路（JSON-RPC 运行时、ACP）有同一条铁律：**stdout 就是协议本身**。JSON-RPC 服务端 README 写死了"部署方不得组合 stdout logger，诊断走 stderr"（`packages/sdk/server/README.md:17`），ACP 同理（`packages/acp/acp/README.md:11`、`examples/acp-agent/README.md:16`）。这不是建议——插件树里混进一个往 stdout 打日志的插件，客户端解析就会碎，而**服务端插件不检查也不否决兄弟 logger**（`packages/sdk/server/README.md:47`；ACP 侧同样的自白见 `packages/examples/acp-demo/README.md:58`）。Python SDK 自己的 stdout 归你的脚本，但它 spawn 的正是 JSON-RPC 那条运行时，所以这条铁律照样压在它头上。

## 2. 一次性跑完：`dsh --profile headless`

最小命令（入口模式见 `apps/cli/README.md:12`，逐字示例见 `apps/cli/README.md:25`）：

```sh
dsh --profile headless "run the tests"
```

从仓库源码跑（`examples/headless-agent/README.md:13`，需先按 `README.md:29-34` 做 `pnpm install && pnpm run build`）：

```sh
pnpm dsh --profile headless "fix the failing test in this workspace"
```

凭据来自环境或仓库根的 gitignored `.env`：`DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`（`examples/headless-agent/README.md:10-12`）。完整优先级是"继承环境 → `$DSH_HOME/.credentials.yaml` → 调用目录 `.env` → `$DSH_HOME/.env`"（`apps/cli/reference/README.md:76`），归第 03 章。

`headless` profile 首次使用会从内置模板自动初始化，层是 base + headless（`apps/cli/reference/README.md:13`）；调用目录就是默认 workspace 根（`apps/cli/README.md:16`）。

### 它到底做了什么（逐行读 runner）

主流程是 `packages/bundle/headless/src/index.ts` 里的 `run()`，第 96–134 行：

| 顺序 | 代码（行号同上文件） | 干什么 |
|---|---|---|
| 1 | `:99` `await ctx.get('loader')?.await()` | 等整棵插件树 settle（每一行插件都加载完或明确失败），再建 Agent |
| 2 | `:111-119` `agents.create({...})` | 建一个全新的持久化会话，id 形如 `session-<uuid>`（`:112`），cwd 取进程当前目录（`:113`） |
| 3 | `:120-121` `whenIdle()` 后取 `agent.session.seq` | 记下**自有区间**的起点 seq |
| 4 | `:122-125` `agent.followup(createUserMessage(...))` | 任务作为一条普通 user message 提交 |
| 5 | `:126` `await agent.whenIdle()` | 等到整个 agent 静默 |
| 6 | `:127` `await sessions.flush(agent.session)` | 先落盘再读 |
| 7 | `:128` `summarize(agent.session.events, firstSeq)` | 折叠这段区间，实现见 `:61-82` |
| 8 | `:129` `io.stdout.write(outcome.text + '\n')` | 只打这一行 |
| 9 | `:133` `io.exit(reason?.kind === 'completed' ? 0 : 1)` | 退出码 |

**自有区间**（本章后面反复用这个词）= 从第 3 步记下的那个 seq 起、到第 5 步再次静默为止，日志里新增的全部事件。`summarize()` 扫这段时先要等到一条 `turn/start` 才开始记（`:67-71`），此后每遇到一条非空 assistant 文本就覆盖 `text`（`:72-78`），每遇到 `turn/end` 就覆盖 `reason`（`:79`）。

| 现象 | 出处 |
|---|---|
| 成功时 stderr 一个字都不写；不开任何监听端口 | `apps/cli/reference/README.md:30` |
| `turn/end` 的 reason 是 `error` 时，stderr 多一行 `dsh: <code>: <message>` | `packages/bundle/headless/src/index.ts:130-132` |
| 退出码：`completed` → 0，其余（含 `max-tokens`）→ 1 | `packages/bundle/headless/src/index.ts:133` |
| 任务为空或全空白 → usage error，runner 根本不激活 | `packages/bundle/headless/src/startup.ts:53`、`packages/bundle/headless/README.md:7` |
| HMR（热重载）行被这层 patch 关掉 | `packages/bundle/headless/cordis.patch.yml:14-15` |
| persona 被换成 coding agent 模板 | `packages/bundle/headless/cordis.patch.yml:7-10` |

**这里最容易踩的是**：`summarize()` 取的是"这段区间里最后一条非空 assistant 文本"，不是"对你这条 prompt 的回答"。README 把这条写成了已知限制：runner 会等完 Agent 在这段区间里干的所有活儿，再打最后一条（`packages/bundle/headless/README.md:19`）。有 steering（回合进行中再插进去的用户输入）、注入上下文或后台活儿时，打出来的可能不是你以为的那句。

另一个坑：`ctx.appExit` 是 launcher 提供的。**不通过 `dsh` 启动器去 boot headless profile，会在激活期直接抛**（`packages/bundle/headless/src/index.ts:144-147`、`packages/bundle/headless/README.md:20`）。它具体从哪来见第 6 节。

> 顺带澄清：`examples/headless-agent/` **不是第二个产品入口**，它是 replay/real-model 的测试组合，其 JSONL 事件流是测试基建，不是受支持的 CLI 输出格式（`examples/headless-agent/README.md:5`、`:18`）。

## 3. JSON-RPC 运行时：协议长什么样

### 起进程

bin 叫 `dsh-jsonrpc-agent`（`packages/examples/jsonrpc-demo/package.json:16-18`）。配置发现只有两个通道，**env 赢**，且**没有任何内建兜底**：

```sh
DSH_CORDIS_CONFIG=/abs/examples/jsonrpc-agent/cordis.yml dsh-jsonrpc-agent
dsh-jsonrpc-agent /abs/examples/jsonrpc-agent/cordis.yml
```

两个都没给出可用文件时，打一行 usage 到 stderr 并 exit 1（`packages/examples/jsonrpc-demo/README.md:9`、`packages/examples/jsonrpc-demo/src/runner.ts:25-36`）。仓库里没有对应的 npm script，从 checkout 起只能自己拼：`node --import tsx packages/examples/jsonrpc-demo/src/bin.ts examples/jsonrpc-agent/cordis.yml`（`pnpm install` 之后；argv 约定见 `runner.ts:26`，这种启动方式见 `package.json:139` 与 `python/sdk/tests/manual_sdk_agent_smoke.py:64`）。

退出：stdin EOF 与 `SIGTERM` → dispose 到静默后 exit 0，`SIGINT` → 130（`packages/examples/jsonrpc-demo/src/runner.ts:51-53`、`packages/examples/jsonrpc-demo/README.md:15`）。**EOF 会砍掉在飞的回合**，要有序收尾就用协议级的 `shutdown`（`packages/examples/jsonrpc-demo/README.md:33`），它会先把响应冲出去、再 dispose 根 context、然后 exit 0（`packages/sdk/server/README.md:21`）。

### 协议表

一帧 = 一行紧凑 JSON，`\n` 结尾；带 `id`+`method` 是请求，只有 `id` 是响应，只有 `method` 是通知；坏 JSON 行被忽略（`packages/sdk/protocol/README.md:9`）。

| 方向 | method | 载荷 |
|---|---|---|
| c→s | `initialize` | `{cwd, provider, model, maxTokens?}` → `{serverInfo:{name,version}}` |
| c→s | `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}` |
| c→s | `shutdown` | 无参 → `{}` |
| s→c | `session.event` | `{sessionId, event}`，运行时里**每一个** session，不过滤 |
| s→c | `session.status` | `{sessionId, status: 'idle' \| 'running'}` |
| s→c | `subagent.started` | `{parentSessionId, childSessionId}` |
| s→c | `subagent.finished` | 仅进程内子 agent（远端 run 不上报） |

出处：`packages/sdk/protocol/README.md:17-23`，字段逐条见 `packages/sdk/protocol/src/types.ts:16-25`（initialize 入参）、`:28-31`（initialize 结果）、`:34-45`（prompt 入参与结果）、`:59-64`（status）、`:93-105`（两张 map）。`serverInfo.name` 恒为 `deepseek-harness-sdk-runtime`，`version` 目前是 `0.0.1` 且客户端不校验（`packages/sdk/protocol/README.md:25`、`:37`）。

客户端写出去的两行长这样——**这是按代码拼的，不是抓包**：payload 形状见 `python/sdk/src/deepseek_harness/client.py:125-131`（initialize，`cwd` 先 resolve 成绝对路径）与 `:146`（prompt），外层信封见 `:248`，compact + `\n` 序列化见 `:303`；`sessionId` 与 prompt 文本取自仓库快照场景 `examples/jsonrpc-agent/tests/sdk.snapshot.ts:86-88`：

```
{"jsonrpc":"2.0","id":"<uuid>","method":"initialize","params":{"cwd":"/abs/workspace","provider":"deepseek-official","model":"deepseek-v4-flash"}}
{"jsonrpc":"2.0","id":"<uuid>","method":"session/prompt","params":{"sessionId":"sdk-snapshot-text","contentBlocks":[{"type":"text","text":"Reply with exactly: SDK snapshot OK"}]}}
```

服务端回过来的头两行则是**逐字取自仓库快照** `examples/jsonrpc-agent/tests/snapshots/text-turn/notifications.expected.jsonl:1-2`（`{{sessionId}}` 是快照占位符，session id 与 message id 都被归一化成了它）：

```
{"method":"session.event","params":{"sessionId":"{{sessionId}}","event":{"type":"agent/inbox/spliced","seq":0,"time":0,"data":{"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"Reply with exactly: SDK snapshot OK"}],"source":{"kind":"user"},"role":"user","id":"{{sessionId}}"}]}}}}
{"method":"session.status","params":{"sessionId":"{{sessionId}}","status":"running"}}
```

### 三条必须知道的语义

1. **`session/prompt` 只返回入队回执**。`messageId` 标识排进 inbox 的那条 `UserMessage`，**不**标识后面的某条 assistant 消息、某次 turn 结束或某个 prompt 结果（`packages/sdk/protocol/README.md:25`、`packages/sdk/server/README.md:25`、`:46`）。
2. **"一次运行"的区间边界得你自己定义**。官方 Python 客户端的做法是：等自己的 `messageId` 出现在 `agent/inbox/spliced` 回执里当作起点（判定见 `python/sdk/src/deepseek_harness/api.py:186-196`），收到该 session 的 `session.status: idle` 当作终点（循环见 `:154-174`）。
3. **没有 cancel，也没有关单个 session 的方法**。放弃一个回合 = 关掉运行时进程；SDK 创建的 agent 活到进程退出为止（`packages/sdk/protocol/README.md:38`、`packages/sdk/server/README.md:45`）。另外没有协议版本协商（`packages/sdk/protocol/README.md:37`）。

服务端插件本身只 `inject: ['agents']`：按 `sessionId` 取或建 agent；已注册的适配器优先，未被认领的 `deepseek-official` 会自动挂 `dsh-llm-deepseek`，其它未认领的 provider 直接让 `initialize` 失败（`packages/sdk/server/README.md:9`、`:48`）。

TypeScript 侧还有个对称的客户端 `@deepseek-ai/dsh-sdk-client`：`DeepSeekHarness` 是高层 owned-run API，`HarnessClient` 是低层协议客户端（`packages/sdk/client/README.md:5`），最小用法见 `packages/sdk/client/README.md:11-22`，选项字段见 `packages/sdk/client/src/types.ts:48-59`，`RunResult` 见 `:62-71`。它**不做打包运行时发现**，`launch: { command, args }` 必须显式给（`packages/sdk/client/README.md:7`、`:46`）。

## 4. Python SDK

### 装 + 跑官方例子

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

装 `deepseek-harness-sdk` 会连带装同版本的 `deepseek-harness-runtime-bin` 平台 wheel，**目标机不需要 Node.js**（`python/sdk/README.md:16`、`docs/user/guide/python-sdk.md:19-27`）。前置条件：Python ≥ 3.10，Linux x64 / arm64 或 macOS 14+ arm64（`docs/user/guide/python-sdk.md:9-13`）。

下面这两段都要在上面这个 checkout 根目录下跑（`minimal.py` 与配置的路径都是仓库相对路径）：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here

python examples/jsonrpc-agent/minimal.py \
  --workspace /absolute/path/to/workspace \
  --session-root /absolute/path/to/sessions \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

（`docs/user/guide/python-sdk.md:33-48`；这些 flag 逐条对应 `examples/jsonrpc-agent/minimal.py:19-25`，另有 `--provider` / `--model` / `--max-tokens` 三个也在那几行里。）模型不在官方端点时，再补一个 `export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1`（`docs/user/guide/python-sdk.md:31`、`:35`）。

### 在自己的程序里调

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

config = Path("examples/jsonrpc-agent/minimal.cordis.yml").resolve()
workspace = Path("/absolute/path/to/workspace").resolve()
sessions = Path("/absolute/path/to/sessions").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    session_root=str(sessions),
    cordis=str(config),
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

（逐字来自 `docs/user/guide/python-sdk.md:56-79`。）

`DeepSeekHarnessConfig` 的全部字段在 `python/sdk/src/deepseek_harness/api.py:22-35`；其中五个会被翻译成子进程环境变量（`api.py:64-72`）：

| 字段 | 环境变量 | 行 |
|---|---|---|
| `session_root` | `DSH_SESSION_ROOT` | `:64-65` |
| `cordis` | `DSH_CORDIS_CONFIG` | `:66-67` |
| `cwd`（先 resolve 成绝对路径，`:60`） | `DSH_CWD` | `:68` |
| `base_url` | `DEEPSEEK_BASE_URL` | `:69-70` |
| `api_key` | `DEEPSEEK_API_KEY` | `:71-72` |

`RunResult` 是 `session_id / final_response / finish_reason / events / notifications / session_root`（`api.py:39-45`）。关键语义（`python/sdk/README.md:45`）：`final_response` 是**这段自有区间里最后一条已提交的 root session assistant 文本**，`finish_reason` 是区间里最后一个 `turn/end` 的 `kind`（README 举的例子是 `completed` / `max-tokens` / `error`），没有 turn 结束时为 `None`。两个字段描述的都是"区间"，不是"因果上属于这条 prompt 的输出"。

**零配置是怎么来的**：运行时二进制永远要求显式配置（`python/sdk-runtime/README.md:29`），`deepseek_harness` 客户端只在"用的是内置运行时 且 `DSH_CORDIS_CONFIG` 为空"时才注入内置默认配置；`runtime_bin` / `bridge_bin` / `launch_args_override` 任给一个就完全不注入（`python/sdk/src/deepseek_harness/client.py:438-454`、`python/sdk/README.md:49`）。注意这三个里只有 `runtime_bin` 和 `launch_args_override` 是高层 `DeepSeekHarnessConfig` 的字段（`api.py:30-31`），`bridge_bin` 只存在于低层 `HarnessConfig`（`client.py:29`）——高层构造函数收到这个关键字会直接报错。

**在 checkout 里跑未编译的 TypeScript 源码**（两条路见 `python/development.md:43-44`），完整可照抄的形状是 `python/sdk/tests/manual_sdk_agent_smoke.py:58-71`：

```python
with DeepSeekHarness(
    model="sdk-smoke-model",
    cwd=str(repo_root / "python/sdk"),
    runtime_cwd=str(repo_root),
    session_root=str(session_root),
    cordis=str(bundled_default_config_path()),
    launch_args_override=("node", "--import", "tsx", str(runtime_entry)),
    env={
        "DEEPSEEK_BASE_URL": base_url,
        "DEEPSEEK_API_KEY": "sdk-smoke-key",
    },
    request_timeout_seconds=20,
    shutdown_timeout_seconds=2,
) as harness:
    ...
```

`runtime_entry` = `repo_root / "packages/examples/jsonrpc-demo/src/bin.ts"`（`manual_sdk_agent_smoke.py:47`），`bundled_default_config_path` 从 `deepseek_harness_runtime` 导入（`:19`）。`python/development.md:44` 给的等价写法是 `launch_args_override=("./node_modules/.bin/tsx", "packages/examples/jsonrpc-demo/src/bin.ts")`、仓库根当工作目录——这里要分清两个字段：子进程的工作目录取 `runtime_cwd`，没给才回落到 `cwd`，而 `cwd` 是发给 agent 的 workspace（`api.py:61`、`:78`）。另一条路是 `DSH_RUNTIME_MODE=node` 用已构建的 node carrier（`python/sdk-runtime/README.md:22`）——自动解析**只会**找生产 exe，dev carrier 必须显式选，免得生产部署悄悄跑在源码构建上。

**`minimal.cordis.yml` 的代价**：它挂的是 `mode: danger-full-access`（`examples/jsonrpc-agent/minimal.cordis.yml:23-27`），bash 和编辑器的绝对路径能改运行时进程可见的**任何**路径，只能在一次性 checkout 或容器里跑；持久 PTY 需要 POSIX 终端，不支持 Windows（`docs/user/guide/python-sdk.md:102`、`examples/jsonrpc-agent/README.md:38`）。它的模型可见工具只有两个：owner 作用域的持久 `bash` 和 `str_replace_editor`（`examples/jsonrpc-agent/README.md:35-36`）。

## 5. ACP

ACP = [Agent Client Protocol](https://agentclientprotocol.com)，dsh 这一侧是**只做自动化的服务端**：让程序化客户端创建全新 agent、发文本 prompt、收已提交的 assistant 文本、按策略回答一次性授权、取消工作（`packages/acp/acp/README.md:5`）。它明确**不是** UI 集成层——不暴露编辑器导航、转录回放、命令、模式、配置选择器、征询（elicitation）、reasoning、plan、标题、工具呈现（`:7`）。

两条 demo 命令都需要 `DEEPSEEK_API_KEY`（仓库根 `.env` 或环境变量，`examples/acp-agent/README.md:8`）：

```sh
pnpm run demo:acp
pnpm run demo:code-mode
```

前者是 `node --import tsx packages/examples/acp-demo/src/bin.ts --config examples/acp-agent/cordis.yml`（`package.json:139`）；后者走 `scripts/demo-code-mode.mjs:9-15`，同一个 bin、同一套协议，配置换成 `examples/acp-agent/code-mode.cordis.yml`（Code Mode 工具传输，见第 20 章）。

bin 形态是 `dsh-acp-demo [--config path-to-cordis.yml]`（短写 `-c`，默认 `./cordis.yml`）；`DSH_SNAPSHOT=replay` 会选同目录的 `cordis.snapshot.yml`（`packages/examples/acp-demo/README.md:45`）。

| 方法 | 行为要点 |
|---|---|
| `initialize` | 协商版本，只广告 baseline prompt（无 image / audio / embedded context），不广告 session、编辑器、终端、文件系统、MCP 能力 |
| `authenticate` | no-op（没广告任何认证方式） |
| `session/new` | 建全新 agent，`cwd` 必须绝对；`additionalDirectories` 与 `mcpServers` **只接受空值**，非空拒绝 |
| `session/prompt` | 拼接文本块（resource link 拍平成 `[resource_link name=… uri=…]` 文本），拒绝空输入与超出 baseline 的输入，每 session 只允许一个在飞请求，等整个 agent 静默 |
| `session/cancel` | 只取消指定 agent 并把它挂起的 prompt 结算成 `cancelled`，未知 id 是 no-op |
| `session/update` | 每条已提交 `assistant/message` 的非空文本块发一个 `agent_message_chunk`；**原始 delta 与非消息事件不发** |
| `session/request_permission` | 桥接方发起的一次性 allow/reject，客户端可自动应答 |

（`packages/acp/acp/README.md:22-30`，resource link 的渲染另见 `:52`。）插件 config 只有 `provider` 和 `model` 两项，都可选，但可运行的 ACP 组合要求两个都给（`:13-18`）。

坑：
- **`stopReason` 不承诺 prompt 级结果**。正常静默报 `end_turn`；显式取消 / 释放 / 被丢弃的准入报 `cancelled`；**token 上限结束也落成 `end_turn`**，模型错误则直接 reject 该 prompt（`packages/acp/acp/README.md:27`、`:40`）。
- 输出是**已提交消息**，故意牺牲逐 token 延迟换干净结果；未提交的 provider chunk 和重试文本不会泄漏出来（`:34`）。
- 每个 `session/new` 自带绝对 `cwd`，沙箱的 `workspace-write` 按该 session cwd 解析，所以并发 session 可以各用各的项目根；`DSH_PERMISSION_MODE` 选 `workspace-write` 还是 `danger-full-access`（`examples/acp-agent/README.md:22`）。`workspace-write` 下模型要更大权限会触发 `session/request_permission`，**客户端不答或答不了就按拒绝处理**（`:24`）。

反向的"dsh 当 ACP 客户端去调别人"是另一个包 `packages/subagent/subagent-acp`（`packages/acp/README.md:5`），归第 18 章。

## 6. 把 dsh 当库嵌进自己的程序：`boot()`

`@deepseek-ai/dsh-app-boot` 是 app bin 共用的启动胶水（`packages/boot/app-boot/README.md:5`）。核心函数签名在 `packages/boot/app-boot/src/index.ts:757-763`：

```ts
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context>
```

最小可用的宿主程序就是仓库里的 ACP demo bin：`packages/examples/acp-demo/src/bin.ts` 的 `:13-29` 共 12 行有效代码（`:18-20` 是覆盖率工具的 `/* v8 ignore */` 指令，下面略去；`:30-34` 另有一段只在快照模式下挂的 stdin EOF 收尾）：

```ts
import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-acp-demo'

installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const ctx = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', snapshotMode))
```

这是个自执行 ESM 文件（顶层 `await`），没有 `main()`。`resolveConfigPath` 负责把相对路径变绝对，并在 `snapshotMode === 'replay'` 时把 `cordis.yml` 换成同目录的 `cordis.snapshot.yml`（`packages/boot/app-boot/README.md:9`）。

JSON-RPC bin 的版本多了退出阶梯，同样可照抄（`packages/examples/jsonrpc-demo/src/runner.ts:38-53`）：`boot()` 之后自己接 `stdin.on('end')` / `SIGTERM` / `SIGINT`，各自 `await ctx.fiber.dispose()` 再 `process.exit(code)`。

### 注意事项

| 事 | 出处 |
|---|---|
| `boot()` 返回时整棵树已 settle，且已跑过 `assertEntriesActivated`：有 entry 没 fiber → 报出每个没解析成的插件名；有 entry 激活失败 → 带插件自己的原始 stack 抛；有 entry 一直 pending → 报它没等到的 service | `packages/boot/app-boot/src/index.ts:782-784`、`packages/boot/app-boot/README.md:26` |
| 失败时它会**先 dispose 掉半成品 context** 再抛带标签的错：`host preparation failed`（prepare 阶段）/ `plugin tree failed to load`（之后） | `packages/boot/app-boot/src/index.ts:767`、`:773`、`:786-801` |
| `prepare` 钩子在任何 config-tree entry 挂载之前跑，用来提供 launcher 自己拥有的 context slot——headless 的 `ctx.appExit` 正是 `dsh` 在这个钩子里 `provideCmdline()` 出来的 | `packages/boot/app-boot/src/index.ts:772`、`apps/cli/src/profile-boot.ts:248-259`、`packages/boot/cmdline/src/index.ts:68-72` |
| 配置放在**别人的 Node 工程**里时，传 `bareModuleBaseUrl`，让你自己安装的插件树保持权威；相对路径 specifier 永远相对配置目录 | `packages/boot/app-boot/README.md:32` |
| 编译产物 bin 需要 Loader 的可选 peer `node-addon-require-builtin` 才能解析 bare 包名；外部调用方要么自己提供，要么只用相对/file specifier，要么自带 module-resolution hook | `packages/boot/app-boot/README.md:32`、`:57` |
| `installFailLoud` 把 boot 期与之后的未处理 rejection 变成一行 stderr + `exit(1)`，可选的 `release` 钩子在两者之间被 await（供占用终端的界面还原终端），返回值是卸载函数 | `packages/boot/app-boot/README.md:12` |
| 用户 patch 按 id 命中时**整体替换 `config`，不深合并** | `packages/boot/app-boot/README.md:60` |

## 7. 评测怎么跑

`BENCHMARK.md` 正文只有一段两句（`BENCHMARK.md:3`）：按 Python SDK 教程装 SDK、跑 `jsonrpc-agent` 的 minimal 变体，**独立的评测任务用独立的 workspace 和 session id**。

为什么这条是硬要求而不是建议：复用同一个 harness + 同一个 session id 会保留**该 session 拥有的 bash 进程**——包括它的工作目录、导出变量和 shell 函数（`docs/user/guide/python-sdk.md:81`、`:100`）。任务 A 的 `cd` 和 `export` 会直接污染任务 B 的起点，评测结果就不再可比。

把 `minimal.py` 已有的 flag（`examples/jsonrpc-agent/minimal.py:19-25`）组合成批量循环：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
while read -r id task; do
  ws="/tmp/bench/$id/workspace"
  mkdir -p "$ws" "/tmp/bench/$id/sessions"
  python examples/jsonrpc-agent/minimal.py \
    --workspace "$ws" \
    --session-root "/tmp/bench/$id/sessions" \
    --session-id "$id" \
    "$task"
done < tasks.tsv
```

（这段循环是把仓库里真实存在的 flag 拼起来的，仓库本身没有这个脚本；`tasks.tsv` 每行 = 任务 id + 空白 + 任务文本。）

要在一个进程里跑，就每个任务开一个新的 `DeepSeekHarness`，或至少每次换 `session_id`——`harness.run(...)` 不传 `session_id` 时会自动生成 `session-<uuid4 十六进制>`（`python/sdk/src/deepseek_harness/api.py:113-115`）。想拿逐事件数据，`RunResult.events` 只含 root session 的事件，`notifications` 才包含子 agent（`python/sdk/README.md:47`）。

## 8. 本章未确认

- ⚠️ 本章**没有运行过任何命令**（仓库未安装依赖）。所有行为均来自源码与文档逐行阅读。
- ⚠️ 第 3 节客户端发出的两行 JSON-RPC 帧是按 `client.py:125-131`/`:146`/`:248`/`:303` 的构造逻辑拼出来的，**未与真实运行时对拍**；服务端返回的两行则逐字取自仓库快照文件。
- ⚠️ 第 3 节那条从源码起 JSON-RPC 运行时的命令，是把 `runner.ts:26` 的 argv 约定与仓库其它 bin 的 `node --import tsx` 启动方式拼起来的推断，仓库里没有逐字出现过。
- ⚠️ `npx @deepseek-ai/dsh` 在仓库里只跟过 `web` 一个子命令（`README.md:20`）；`dsh --profile headless "run the tests"` 虽逐字出现在 `apps/cli/README.md:25` 与 `apps/cli/reference/README.md:30`，但从未与 `npx` 拼在一起，两者拼接的写法未经验证。
- ⚠️ 本章没有给 ACP 的原始 wire 帧：`examples/acp-agent/tests/snapshots/*/input.json` 用的是测试 harness 自己的步骤 DSL（`{"op":"initialize"}` 之类），不是协议帧，无法据此还原逐字 JSON。要看真帧请读 ACP 官方规范与 `packages/acp/acp/src/`。
- ⚠️ `deepseek-harness-sdk` / `deepseek-harness-runtime-bin` 在 PyPI、`@deepseek-ai/dsh-sdk-jsonrpc-demo` 在 npm 是否已实际发布，以及各平台 wheel 是否齐全，均未核实——仓库里只有 `publishConfig.access: public`（`packages/examples/jsonrpc-demo/package.json:5-7`）和文档描述，未在代码中确认发布状态。
- ⚠️ `deepseek-harness-runtime-bin` 的运行时二进制在 git 里是被忽略的构建产物（`python/sdk-runtime/README.md:9`），因此本章无法验证内置运行时的实际行为，只能验证客户端侧的解析与注入逻辑。
