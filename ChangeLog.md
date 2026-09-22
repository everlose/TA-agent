# ChangeLog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.1] - 2026-09-22

首个版本：ReAct 文本协议驱动的极简 Agent。对照学习目标，各模块现状：

- **Agent Loop** — 已完成。`src/core/agent-loop.ts` 单步串行 ReAct 循环，上限 20 步，支持取消。
- **工具系统** — 已完成。`ToolRegistry` 统一注册与执行，内置 `list_files` / `read_file` / `run_terminal_command`，提示词中的工具清单由注册表动态生成。
- **上下文管理** — 部分完成。`ContextManager` 维护消息历史，目前仅有骨架，摘要与裁剪未实现，且不跨任务。
- **子 Agent** — 未实现。
- **异常管理** — 部分完成。`ProtocolError` / `MaxStepsError` / `UnknownToolError` 分级，工具异常转为 observation 回灌给模型；但模型输出的协议解析仍偏脆弱。

详细机制与不足见 [agent-loop.md](./agent-loop.md)。
