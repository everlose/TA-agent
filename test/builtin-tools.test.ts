import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createBuiltinTools } from "../src/tools/builtin-tools.ts";
import type { CommandToolOptions } from "../src/tools/builtin-tools.ts";
import type { AgentTool, CommandApproval } from "../src/types.ts";

/** 测试用工作目录：本组用例只跑不落盘、或由用例自行清理的命令。 */
const WORKDIR = process.cwd();

/** 取出运行终端命令的工具；审批默认放行。 */
function commandTool(approve: CommandApproval = async () => true, options: CommandToolOptions = {}): AgentTool {
  const tool = createBuiltinTools(WORKDIR, approve, options).find((item) => item.name === "run_terminal_command");
  assert.ok(tool, "内置工具里应当有 run_terminal_command");
  return tool;
}

/** 是否还有匹配的进程残留。 */
function hasProcess(pattern: string): boolean {
  try {
    execSync(`pgrep -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 等待，用于跨过 SIGTERM 到 SIGKILL 的升级窗口。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("run_terminal_command", () => {
  it("取消会 kill 整棵进程树，管道里的孙进程也不残留", async () => {
    const controller = new AbortController();
    // 用独一无二的时长做标记，便于精确判断这个进程是否残留。
    // 工具签名声明为 string | Promise<string>，这里固定成 Promise 便于后续断言。
    const pending = Promise.resolve(commandTool().execute(["sleep 53 | cat"], { workdir: WORKDIR, signal: controller.signal }));

    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (error: Error) => error.name === "AbortError");

    await delay(800);
    assert.equal(hasProcess("sleep 53"), false, "取消后不应残留管道里的 sleep 53");
  });

  it("命令正常结束时返回退出码与输出", async () => {
    assert.equal(await commandTool().execute(["echo hello"], { workdir: WORKDIR }), "退出码：0\nhello");
  });

  it("非零退出码作为观察返回，而不是抛错", async () => {
    assert.equal(await commandTool().execute(["exit 3"], { workdir: WORKDIR }), "退出码：3");
  });

  it("用户拒绝审批时不执行命令", async () => {
    assert.equal(await commandTool(async () => false).execute(["echo nope"], { workdir: WORKDIR }), "用户拒绝执行该命令");
  });

  it("审批回调能拿到当前任务的取消信号", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const tool = commandTool(async (_command, signal) => {
      received = signal;
      return false;
    });

    await tool.execute(["echo x"], { workdir: WORKDIR, signal: controller.signal });

    assert.equal(received, controller.signal);
  });

  it("信号已取消时不再启动命令", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => commandTool().execute(["echo never"], { workdir: WORKDIR, signal: controller.signal }),
      (error: Error) => error.name === "AbortError",
    );
    assert.equal(hasProcess("echo never"), false);
  });

  it("缺少命令时报错", async () => {
    await assert.rejects(async () => commandTool().execute([], { workdir: WORKDIR }), /缺少命令/);
  });

  it("超时同样终止整棵进程树，管道里的孙进程不残留", async () => {
    // 缩短超时以便快速触发；spawn 自带的 timeout 只杀直接子进程，所以这里走自实现的整树终止。
    const tool = commandTool(async () => true, { timeoutMs: 200 });

    assert.equal(await Promise.resolve(tool.execute(["sleep 57 | cat"], { workdir: WORKDIR })), "退出码：1");

    await delay(800);
    assert.equal(hasProcess("sleep 57"), false, "超时后不应残留管道里的 sleep 57");
  });
});
