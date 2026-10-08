import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/config-loader.ts";
import { OpenAIClient } from "../model/openai-client.ts";
import { AgentLoop } from "../core/agent-loop.ts";
import { CancellationController } from "../core/cancellation.ts";
import { bindInterrupts } from "./interrupts.ts";
import { createApproval } from "./approval.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { createBuiltinTools } from "../tools/builtin-tools.ts";
import { DebugLogger } from "../core/debug-logger.ts";
import { EventBus } from "../core/event-bus.ts";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../types.ts";

/** 创建模型、工具注册表和 Agent Loop，集中完成依赖装配。 */
function createRuntime(workdir: string, rl: readline.Interface): AgentLoop {
  const model = new OpenAIClient(loadConfig(workdir));
  const debugLogger = new DebugLogger(workdir);
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(workdir, createApproval(rl))) registry.register(tool);
  const eventBus = new EventBus();
  eventBus.subscribe((event: AgentEvent): void => {
    if (event.type === "thought") console.log(`\n💭 ${event.data?.content}`);
    if (event.type === "tool_start") console.log(`\n🔧 ${String(event.data?.toolName)}(${(event.data?.args as string[]).join(", ")})`);
    if (event.type === "tool_result") console.log(`\n🔍 ${event.data?.observation}`);
    if (event.type === "model_retry") {
      const cause = event.data?.status ? `HTTP ${event.data.status}` : "网络异常或超时";
      console.log(`\n⏳ ${cause}，${Number(event.data?.delayMs) / 1000}s 后重试（${event.data?.attempt}/${event.data?.maxAttempts}）`);
    }
    if (event.type === "task_completed") console.log(`\n📋 任务完成：${event.taskId}`);
    if (event.type === "task_failed") console.error(`\n📋 任务失败：${event.data?.message}`);
    if (event.type === "task_cancelled") console.log(`\n📋 任务已取消：${event.taskId}`);
  });
  const sessionId = randomUUID();
  debugLogger.write("session:init", { sessionId, workdir });
  console.log(`会话 ID：${sessionId}`);
  console.log(`调试日志：${debugLogger.getFilePath()}`);
  return new AgentLoop(model, registry, workdir, eventBus, sessionId, 20, debugLogger);
}

/** 启动交互式命令行程序。 */
export async function startCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const workdir = path.resolve(argv[0] || ".");
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error(`目录不存在：${workdir}`);
  const rl = readline.createInterface({ input, output, historySize: 1000 });
  const cancellation = new CancellationController();
  const unbind = bindInterrupts(cancellation, rl, () => {
    rl.close();
    process.exit(0);
  });
  try {
    const agent = createRuntime(workdir, rl);
    console.log(`Agent 已启动，工作目录：${workdir}\n输入任务，输入 quit 或 exit 退出。`);
    while (true) {
      const question = (await rl.question("\n你 > ")).trim();
      if (["quit", "exit"].includes(question.toLowerCase())) break;
      if (!question) continue;
      // 每个任务一个新信号：AbortSignal 一旦 abort 就永久为 aborted，不能跨任务复用。
      const signal = cancellation.start();
      try {
        console.log(`\n🤖 ${await agent.run(question, signal)}`);
      } catch (error) {
        // 取消是用户主动行为，task_cancelled 事件已经提示过，这里不再重复报错。
        if ((error as Error).name !== "AbortError") console.error(`\n错误：${(error as Error).message}`);
      } finally {
        cancellation.finish();
      }
    }
  } finally {
    unbind();
    rl.close();
  }
}
