# ChangeLog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.3] - 2026-09-23

把取消能力接进 CLI，端到端取消闭环打通。

### 新增

- **`CancellationController`**（`src/core/cancellation.ts`）：取消信号的唯一入口。每个任务分配独立的 `AbortController`，任务收尾后释放，杜绝复用已 abort 的信号。
- **Ctrl+C 分级语义**（`src/cli/interrupts.ts`）：首次 Ctrl+C 只取消当前任务，给 Agent 收尾机会；空闲时按下、或任务已在取消中再次按下才退出程序。同时监听 readline 与 process 两级，交互式按键与外部 `kill -INT` 都生效。
- **取消在 CLI 可见**：`AbortError` 不再被当成故障报错，改由 `task_cancelled` 事件统一提示。

### 修复

- 补上 0.0.2 声明的缺口：取消信号此前没有创建与触发的入口，`AbortSignal` 到不了 `fetch`，Ctrl+C 只会杀掉整个进程并把 `debug/*.jsonl` 截断。现已贯通 CLI → Agent Loop → 模型请求 → 重试等待。
- 模型返回后、执行工具前补一次取消检查，避免用户刚好在此刻取消时白执行一个工具。

### 验证

- 单元测试增至 25 个：新增取消控制器、中断接线与 Agent Loop 取消路径三组用例。
- 真实终端（PTY）端到端验证：模型请求挂起时按一次 Ctrl+C，进程输出「已请求取消当前任务」并回到提示符，`fetch` 立即断开，日志得到完整的 `task_started → step_start → step_finish(cancelled) → task_cancelled` 事件链。

### 已知边界

- 工具执行本身仍不可打断：`ToolRegistry.execute` 不接收 signal，`run_terminal_command` 的子进程与工具审批问答不会因取消而中止，此时需要第二次 Ctrl+C 强制退出。工具级取消（含子进程 kill）留待后续版本。

## [0.0.2] - 2026-09-22

模型请求失败的重试与取消支持。

### 新增

- **模型调用重试**：命中 429 或 5xx、网络异常、请求超时时自动重试，最多 3 次；指数退避，并优先采信响应头 `Retry-After`。其余状态码（400 / 401 / 404 等）立即报错，不重试。
- **总预算保护**：单次模型调用含全部重试与等待的时长上限默认 180 秒，预算不足时直接放弃，避免长时间空等。
- **`model_retry` 事件**：CLI 实时提示重试进度，并写入 `debug/*.jsonl`。
- **单元测试**：新增 `test/` 目录，基于 Node 内置 `node:test`，零依赖。`npm test` 可运行。

### 修复

- 取消信号此前未从 Agent Loop 透传到模型请求，`AbortSignal` 到不了 `fetch`；现已在库层贯通请求与重试等待。注意：CLI 尚未接入 `SIGINT`，目前没有创建与触发取消信号的入口，端到端取消待后续版本补齐。

### 背景

0.0.1 的调试日志中，唯一一次任务硬失败来自 `HTTP 429 gateway_concurrency_limit`——首次模型调用即被限流打死，当时没有任何重试。0.0.2 针对此类瞬时失败补齐了重试能力。

## [0.0.1] - 2026-09-22

首个版本：ReAct 文本协议驱动的极简 Agent。对照学习目标，各模块现状：

- **Agent Loop** — 已完成。`src/core/agent-loop.ts` 单步串行 ReAct 循环，上限 20 步，支持取消。
- **工具系统** — 已完成。`ToolRegistry` 统一注册与执行，内置 `list_files` / `read_file` / `run_terminal_command`，提示词中的工具清单由注册表动态生成。
- **上下文管理** — 部分完成。`ContextManager` 维护消息历史，目前仅有骨架，摘要与裁剪未实现，且不跨任务。
- **子 Agent** — 未实现。
- **异常管理** — 部分完成。`ProtocolError` / `MaxStepsError` / `UnknownToolError` 分级，工具异常转为 observation 回灌给模型；但模型输出的协议解析仍偏脆弱。

详细机制与不足见 [agent-loop.md](./agent-loop.md)。
