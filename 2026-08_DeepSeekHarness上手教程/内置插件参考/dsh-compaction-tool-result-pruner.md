# compaction-tool-result-pruner

> `@deepseek-ai/dsh-compaction-tool-result-pruner` · bundle：`base` · 配置树 id：`tool-result-pruner` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

> ⚠️ **本篇未通过对抗式引用核验**：起草已完成，但逐条打开源码比对行号/字段名/英文引文的那一遍因会话额度耗尽未执行。文中 `path:line` 与配置字段请以源码为准，核验后本行会被移除。

**一句话**：不调模型的确定性剪枝服务——把 surface 上超预算的 `tool/result` 节点重写成「头部 + 固定省略标记 + 尾部」，原始事件仍完整留在 append-only 会话日志里。

## 它在树上长什么样

```yaml
    # Compacts oversized tool results before the broader conversation compactor
    # runs, preserving the model-visible result within the configured budget.
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
```

这三个值和代码里的 `DEFAULTS` 完全一致，bundle 只是把它们写明。web profile 里同样被关掉。

出处：bundle 片段见 `packages/bundle/base/cordis.patch.yml:358-365`；`DEFAULTS` 见 `packages/compaction/compaction-tool-result-pruner/src/config.ts:10-14`；web profile 见 `packages/bundle/web-app/cordis.patch.yml:364-365`。

这里有个看着像 bug 的地方：它在 base 里排在第 360 行，**在 `compaction-basic`（第 284 行）后面**。按常理后加载的服务应该拿不到，但这不影响可用性——[compaction-basic](./dsh-compaction-basic.md) 是运行时用 `ctx.get('toolResultPruner')` 软查的，不是 `inject`。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.toolResultPruner` | `super(ctx, 'toolResultPruner')`（`packages/compaction/compaction-tool-result-pruner/src/index.ts:59`），Context 声明合并在 `:32-36` |
| inject | `tokenMeter` | `static inject = ['tokenMeter']`（`packages/compaction/compaction-tool-result-pruner/src/index.ts:47`），用来给被影子化的节点定价 |
| 会话事件 | `compaction/prune` | log-only 的影子定价事件，紧跟其后同步追加替换用的 `tool/result`（`packages/compaction/compaction-tool-result-pruner/src/index.ts:162-173`；事件定义 `packages/compaction/compaction/src/types.ts:81-88`） |

**没有事件监听、没有工具、没有 prompt 段。**

它是纯被动服务：自己不会主动跑，只有 compaction-basic 在压力或溢出合格之后调用 `pruneSession(session)` 才动。

服务 API 就三个方法：

| 方法 | 做什么 |
|---|---|
| `pruneSession(session)` | 扫一次当前 surface 的稳定快照 |
| `measureContent(blocks)` | 数 `text` 块的 Unicode 码点 |
| `pruneContent(blocks)` | 返回有界替换；已在阈值内则返回 `null` |

后两个方法合起来就是全部机制：

```
pruneContent(blocks):
    n = measureContent(blocks)              // 只数 text 块的 Unicode 码点
    if n <= thresholdChars: return null     // 已经在预算内，一个字不动
    return 前 headChars 个码点
         + MARKER
         + 后 tailChars 个码点              // 非文本块按原相对位置保留
```

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `thresholdChars` | number | `8192` | 合并文本超过这么多 Unicode 码点才剪 |
| `headChars` | number | `4096` | 保留的前导码点数 |
| `tailChars` | number | `1024` | 保留的尾部码点数 |

全部是整数，阈值为正、头尾非负。还有一条跨字段约束，不满足就在构造期直接抛错；未知键同样在插件构造期失败（`packages/compaction/compaction-tool-result-pruner/src/config.ts:55-63`）：

```
headChars + len(MARKER) + tailChars <= thresholdChars
```

这条约束的意义比看上去大：它保证剪完的长度天然不超过 `thresholdChars`，于是「剪完一定更小」，而且第二遍再量时 `pruneContent` 必然返回 `null`——不会反复剪同一个节点。

## 模型看得见什么

被剪的工具结果在后续请求里变成保留头部 + 固定标记 + 保留尾部。标记是硬编码的：

```text
\n\n[... tool result middle pruned ...]\n\n
```

非文本块按原相对位置保留，模型不会看到原文的第二份副本（标记定义见 `packages/compaction/compaction-tool-result-pruner/src/config.ts:7`）。

剪枝本身**不产生任何模型调用**。compaction-basic 重新计量后如果压力已经降到线下，就直接跳过摘要（`packages/compaction/compaction-basic/src/index.ts:310-312`）——也就是说，运气好的话整轮压缩一次模型都不用调。

KV cache 方面：替换一条更早的结果会从第一个改变的 token 起让复用失效，剪过的前缀在路由、envelope 和更早历史不变时仍可复用。

## 什么时候你会想换掉它 / 怎么换

| 诉求 | 做法 | 后果 |
|---|---|---|
| 想少剪一点 | 调大 `thresholdChars` | 需同时保证头尾加标记仍装得下 |
| 想彻底关掉 | `disabled: true` | compaction-basic 会通过 `ctx.get()` 拿到 `undefined` 并跳过整个 model-free 通道，只剩摘要压缩 |
| 换实现 | 写一个同名服务的替代 provider | 这是普通 cordis service；同一 context 内一个服务只能有一个实现 |

关掉之后只剩摘要压缩这件事说明两个包各自独立可组合，不存在硬依赖。

它和 [spill-policy](./dsh-spill-policy.md) 治的是同一类症状，但层次不同：spill-policy 在**工具执行时**按 UTF-8 字节封顶模型可见结果（append-only）；本插件在**压缩时**按 Unicode 码点重写**已经进了日志的** surface 节点（replace）。

两者都开时，先被 spill 截断的结果通常已在 `maxInlineBytes` 之下，不会再触发这里的阈值：

```mermaid
flowchart LR
    subgraph S1["spill-policy"]
        A1["<b>工具执行时封顶</b><br/>按 UTF-8 字节，append-only"]
    end
    subgraph S2["tool-result-pruner"]
        A2["<b>压缩时重写</b><br/>按 Unicode 码点，replace 已入日志节点"]
    end
    A1 -- "通常已在阈值之下" --> A2

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class A1 main
    class A2 data
```

## 坑与边界

**字符预算不是 token 预算。** 各家 token 密度不同，判断剪枝有没有真正缓解压力仍以 `ctx.tokenMeter` 为准。

**剪枝是语法性的。** 只留头尾，不理解中间哪几行语义上更重要。

**可能切断字形簇。** 按码点切保护了代理对，但不做本地化的 grapheme 分段。

最后一条最容易忽略：`pruneSession` 在 session 拒绝某次替换时**同步抛出**，而本轮更早提交的替换仍然是持久的（`packages/compaction/compaction-tool-result-pruner/src/index.ts:136` 的文档注释）。也就是说失败不是原子回滚：

```
for 每个超预算节点:
    提交替换        // 已提交的落在日志里，不撤
    if session 拒绝: throw   // 直接抛出，前面那些替换照样生效
```

compaction-basic 把这种「剪枝已落地但后续摘要失败」的情况当作有效的重试凭据（`packages/compaction/compaction-basic/src/index.ts:201-208`）。
