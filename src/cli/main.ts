import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/config-loader.ts";
import { OpenAIClient } from "../model/openai-client.ts";
import { AgentLoop } from "../core/agent-loop.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { createBuiltinTools } from "../tools/builtin-tools.ts";
import { DebugLogger } from "../core/debug-logger.ts";
import { EventBus } from "../core/event-bus.ts";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../types.ts";

/** 创建危险命令的终端确认回调。 */
function createApproval(rl: readline.Interface): (command: string) => Promise<boolean> {
  return async (_command: string): Promise<boolean> => {
    // 只接受单个 y/Y 或 n/N，其他输入不会改变状态，避免误执行命令。
    while (true) {
      const answer = (await rl.question("是否执行此命令？输入 y/Y 执行，n/N 取消：")).trim();
      if (answer === "y" || answer === "Y") return true;
      if (answer === "n" || answer === "N") return false;
      console.log("请输入 y/Y 或 n/N。");
    }
  };
}

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
  try {
    const agent = createRuntime(workdir, rl);
    console.log(`Agent 已启动，工作目录：${workdir}\n输入任务，输入 quit 或 exit 退出。`);
    while (true) {
      const question = (await rl.question("\n你 > ")).trim();
      if (["quit", "exit"].includes(question.toLowerCase())) break;
      if (!question) continue;
      try { console.log(`\n🤖 ${await agent.run(question)}`); }
      catch (error) { console.error(`\n错误：${(error as Error).message}`); }
    }
  } finally { rl.close(); }
}
