# Agent Loop 现状

核心实现：`src/core/agent-loop.ts` 的 `run()`（约 50 行）。原型机见 `agent.simple.ts`，逻辑同源。

## 一、当前机制

一个手写的 **ReAct 单步串行状态机**。模型无状态，Loop 是唯一持有状态的地方；每轮迭代 = 一次模型调用 + 至多一次工具调用。

```
for step = 1..maxSteps(20):
  ① content = model.complete(整个 context)   ← 全量重放历史
  ② 正则抠 <thought> / <action> / <final_answer>
  ③ 有 final 且无 action → return，结束
     有 action           → 执行
     两者都无             → ProtocolError
  ④ split("|") → toolName + args
  ⑤ observation = tools.execute(...)
  ⑥ context 追加 assistant 原文 + <observation>
```

几个要点：

- **协议是纯文本，不用原生 tool calling**。模型输出 `<action>list_files|.</action>`，Loop 用正则解析。好处是任何 OpenAI 兼容模型都能跑；代价是解析脆弱。
- **action 优先于 final_answer**。同一轮里两者都出现时，final 被忽略、action 照常执行，防止模型抢答谎报完成。
- **工具错误转成 observation**。`agent-loop.ts:78` catch 住异常转字符串回灌，工具失败不打断循环，而是变成模型可自我纠正的输入。
- **上下文**：`ContextManager` 维护 `[system, user(question), assistant, user(observation), ...]`。observation 包成 **user 角色**而非 tool 角色。每次 `run()` 新建，任务间无记忆。
- **工具清单动态生成**。提示词里的工具列表来自 `ToolRegistry.describeForPrompt()`，避免提示词与注册表两套清单漂移。
- **解耦与可观测**。Loop 不直接打印，发事件（`step_start`/`thought`/`tool_start`/`tool_result`/`task_completed`…），由 CLI 订阅渲染，同时写 `debug/*.jsonl`。
- **两个硬边界**：`maxSteps=20` 防死循环，`signal.aborted` 支持取消（0.0.3 起由 CLI 的 Ctrl+C 触发）。

## 二、不足之处

### 上下文管理只有骨架

`context.ts` 注释写「为后续摘要和裁剪预留边界」，但裁剪与摘要均未实现。每步全量重发历史，真正撞墙的是步数上限而非 token 上限。

### 上下文不跨任务

同一 session 连续提两个问题，第二个看不到第一个的记忆。

### 文本协议的解析脆弱性

- 模型少一个闭合标签即失败；
- 参数用 `|` 分隔，导致参数本身不能含 `|`，`run_terminal_command` 只能 `args.join("|")` 反向拼回管道符（`builtin-tools.ts:45`）；
- 无 JSON Schema 级别的参数类型校验。

### 单步串行，无法并行

只取 `actionMatches[0]`，一轮至多一个工具，无并发调用能力。

### 子 Agent 未实现

README 列为学习目标，`src/` 下无相关代码。

### 取消覆盖不到工具执行

0.0.3 已把 Ctrl+C 接进 CLI，模型请求与重试等待都能被打断；但 `ToolRegistry.execute` 不接收 signal，`run_terminal_command` 的子进程、以及工具审批的问答都不会中止。此时取消请求会被挂着的工具拖住，只能再按一次 Ctrl+C 强制退出。

### 靠 prompt 约束而非结构约束

「没真调工具不得声称任务完成」只能写在提示词规则 7 里，靠 `toolCallCount` 事后审计，无法从结构上阻止模型编造。

## 三、改进方向

| 优先级 | 项 | 做法 |
| --- | --- | --- |
| 高 | 上下文裁剪/摘要 | 接近 token 阈值时压缩早期步骤为摘要，或保留最近 N 轮 + 工具结果截断 |
| 高 | 原生 tool calling | 切到 `tools` / `tool_calls` 字段，参数交给 JSON Schema 校验，消除 `\|` 分隔的妥协 |
| 中 | 跨任务记忆 | ContextManager 提升到 session 级，或落盘复用 |
| 中 | 并行工具调用 | 允许一轮多 action，用 `Promise.all` 并发执行 |
| 中 | 工具级取消 | `ToolContext` 带上 signal，`run_terminal_command` 改用 `spawn` 并在取消时 kill 子进程，审批问答也响应取消 |
| 低 | 子 Agent | 让 `spawn_agent` 成为一个工具，内部递归复用 AgentLoop |
| 低 | 协议容错 | 解析失败时回灌一条纠正提示重试，而非直接抛 ProtocolError |
