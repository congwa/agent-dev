# tool-todo

> `@deepseek-ai/dsh-tool-todo` · bundle：`base` · 配置树 id：`tool-todo` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

> ⚠️ **本篇未通过对抗式引用核验**：起草已完成，但逐条打开源码比对行号/字段名/英文引文的那一遍因会话额度耗尽未执行。文中 `path:line` 与配置字段请以源码为准，核验后本行会被移除。

**一句话**：一个只有 `todo_write` 一件事的插件——模型每次把**整张任务清单**重发一遍，插件把快照原样 append 成一条 `todo/write` 会话事件，UI 从事件流里自己渲染。

README:5 原话：`The model-facing todo_write tool: the agent's whole task list, replaced wholesale on each call.`

## 它在树上长什么样

```yaml
    - id: tool-todo
      name: '@deepseek-ai/dsh-tool-todo'
      config:
        allowParallelInProgress: true
```

`packages/bundle/base/cordis.patch.yml:367-370`。这一行同样没写 `inject`，依赖在源码里：`export const inject = ['tools']`（`packages/todo/tool-todo/src/index.ts:23`）。

`web-app` bundle 在宿主平面关掉它（`packages/bundle/web-app/cordis.patch.yml:404-405`），由 preset 挂回来，配置一模一样（`apps/cli/config/agent-presets/code/agent.cordis.yml:241-244`）。

**导出形态是个坑点，README 专门开了一节**（README:37）：`A function/namespace plugin: it exports name / inject / apply and NO default. A stray export default would collapse the module via the Loader's unwrapExports and drop inject`——参见 `docs/postmortem/0001-acp-default-export-drops-inject.md`。这跟同组的 [plan-mode](./dsh-plan-mode.md) 正好相反，后者是 Service 类 + `export default`。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 工具 | `todo_write` | `src/index.ts:149`；一个必填参数 `todos: array`，item 是 `{ content, status }` 且 `additionalProperties: false` |
| 会话事件 | `todo/write`（`{ todos: TodoItem[] }`） | `src/index.ts:213` 追加；类型声明在 `packages/core/session/src/types.ts:299`，注释写着 `Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history.` |
| projection unit | `todos` → `TodoItem[] \| null`，`stateVersion: 2` | `src/index.ts:135-148`，仅当 `ctx.sessionProjections` 已挂载 |
| 伴生插件 | `./invariant`（`tool-todo-invariant`） | `src/invariant.ts:24-39` |

**没有事件监听**——它不参与任何 waterfall，纯粹是个工具注册者。`docs/event-producer-consumer.md:71` 把它列为 `internal/dispatch` 消费方，那条来自伴生插件（`src/invariant.ts:52`），不是主插件。

`todos` unit 的 fold 是「standing plan」语义（`src/index.ts:140-144`）：`todo/write` 覆盖整张表，`turn/start` 清成 `null`，`turn/end` **不清**（跑完的清单要留在屏幕上），其余事件原样返回同一个 state 引用。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `allowParallelInProgress` | `boolean` | **无默认，必填**（`z.boolean().required()`，`src/index.ts:42`） | 允不允许同时有多条 `in_progress` |

README:19 讲清了为什么不给默认：`It is a deployment choice, not a fixed rule: whether concurrent active tasks are legitimate depends on runtime concurrency the tool cannot observe.`

这个 flag **同时**改两样东西（README:21）：

| 取值 | 工具描述那一句 | 输入校验 |
|---|---|---|
| `true` | `Mark every todo being actively worked on in_progress — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; …`（`src/index.ts:51-55`） | 不限个数 |
| `false` | `Keep AT MOST ONE todo in_progress at a time; …`（`src/index.ts:57-59`） | 超过 1 条报 `invalid todos: at most one task may be in_progress (got <n>)` |

base 选 `true`，理由就在描述文案里：这棵树上有并发 subagent 和后台命令，还有 [tool-ralph](./dsh-tool-ralph.md) 那种一轮一个 child 的编排。

**但耐久层的 invariant 故意不跟着变**（README:21、`src/invariant.ts:16-23`）：`a log written while parallel work was allowed must still replay after a deployment tightens the policy, so the invariant stays silent on the active count.` invariant 只管数组形状、`content` 非空且已 trim、不重复、`status` 在三值枚举内。

## 模型看得见什么

- **schema 固定开销**，只要工具可见就每次请求都付（README:49）。
- **每次调用的完整清单留在 assistant 的 arguments 里**，直到 compaction 才消失（README:63）。这是这个工具真正的 token 成本大头，不是那条结果。
- **成功结果只有一行**：`Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.`（`src/index.ts:201-204`）。
- **四条稳定的失败文案**（README:59）：

| 文案 | 出处 |
|---|---|
| ``Error: invalid todo: `content` must be a non-empty string`` | `src/index.ts:98` |
| `Error: invalid todos: duplicate content "<content>"` | `src/index.ts:101` |
| `Error: todo_write requires an owning agent session` | `src/index.ts:211` |
| `Error: invalid todos: at most one task may be in_progress (got <n>)`（仅 `false` 时） | `src/index.ts:108` |

- **`todo/write` 事件本身不是第二条模型消息**（README:59 结尾），它只是 UI 和 replay 状态。

注意：[plan-mode](./dsh-plan-mode.md) 默认 `section` 里有一句直接压制它（`packages/bundle/base/cordis.patch.yml:273`）：`Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.` 计划模式下这个工具虽然在目录里，但提示层禁止用。

## 什么时候你会想换掉它 / 怎么换

- **收紧成单任务纪律**：把 `allowParallelInProgress` 改成 `false`。历史日志不受影响（见上面 invariant 那段）。
- **换渲染**：换不了，也不需要——渲染不在这个包里。它只写 `todo/write`，Web 端从事件流自己画 plan strip（README:29），换 UI 就是换 client 包。
- **想要局部更新 / 读回工具 / 带 id 的 item**：没有，而且是明确切掉的（README:72-73）。要这些就得自己写一个新工具包，别改这个。
- **整个关掉**：`- id: tool-todo` + `disabled: true`。之后 `todos` projection key 直接缺席（`src/types.ts:15-23` 把 key 声明在这里），不是给个空值。

## 坑与边界

README:71-73 三条：

- **只有单一 owner**——清单属于调用它的那一个 agent session，没有 subagent / shared / swarm 作用域，非 agent 调用者直接拒绝。README:15 说这是 `a deliberate scope limit`。实践含义：Ralph 的每个 fresh child 都有自己独立的一张表，跨轮不继承。
- **item 形状故意最小**——只有 `content` + 三态 `status`，整表替换不需要稳定 id、优先级、进行时文案。
- **整表替换是唯一操作**——没有增量更新，没有读回工具，模型每次必须重发全表。

读源码补充：

- `additionalProperties: false` 卡在参数 schema 层（`src/index.ts:160`），多一个 key 就在注册表边界失败。`src/index.ts:82-89` 的注释解释了动机：`the logged snapshot must equal what the model believes it wrote, so a nested/extended item shape fails loud at the schema boundary instead of silently flattening`。
- `content` 在 `toTodoList` 里被 **trim 后**才判空、判重（`src/index.ts:96-103`），所以 `"a"` 和 `" a "` 算重复。
- 排序和「保持清单最新」这件事完全靠工具描述劝模型（README:25 末句），代码不管。
- `execute` 是同步逻辑包了个 `Promise.resolve`（`src/index.ts:215`），`session.append` 抛错会直接变成工具失败。
