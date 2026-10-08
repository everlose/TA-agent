import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentTool, CommandApproval, ToolContext } from "../types.ts";

/** 单次命令的最长执行时间，与旧版 exec 的 timeout 保持一致。 */
const COMMAND_TIMEOUT_MS = 120_000;

/** SIGTERM 之后留给命令自行收尾的时间，超时仍未退出就升级为 SIGKILL。 */
const KILL_ESCALATION_MS = 500;

/** 累积输出的上限，防止长时间命令把内存吃满（与旧版 exec 的 maxBuffer 对齐）。 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** run_terminal_command 的可调参数，主要供测试缩短超时。 */
export interface CommandToolOptions {
  timeoutMs?: number;
}

/**
 * 正在运行的命令进程组。
 * 命令以 detached 方式启动，不随父进程一起退出，所以强退时需要兜底清理。
 */
const liveCommandGroups = new Set<number>();

/** 按进程组结束命令：shell 及其派生的子进程（管道、&& 链）一起收掉。 */
function killCommandGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch {
    // 进程组已消失，说明命令自己结束了。
  }
}

// CLI 强制退出（第二次 Ctrl+C）时兜底：detached 的子进程不会自动跟着死。
process.on("exit", () => {
  for (const groupId of liveCommandGroups) killCommandGroup(groupId, "SIGKILL");
});

/** 将工具路径限制在工作目录内，避免访问工作区之外的文件。 */
function resolveSafePath(workdir: string, value = "."): string {
  const target = path.resolve(workdir, value || ".");
  if (target !== workdir && !target.startsWith(`${workdir}${path.sep}`)) throw new Error("路径不能超出工作目录");
  return target;
}

/**
 * 执行一条 shell 命令，返回可直接回灌给模型的观察文本。
 *
 * 为什么用 spawn 而不是 exec：exec 只在命令结束或超时后才交出结果，外部没有
 * 中途终止它的手段，取消信号根本传不进去。
 *
 * 为什么要 detached：只杀直接子进程是不够的 —— shell 派生出的孙进程（`a | b`、
 * `a && b`）不会跟着死。让 shell 当独立进程组的组长，才能按组整棵树一起收掉。
 *
 * 超时也自己实现而不用 spawn 的 timeout 选项，理由同上：后者同样只杀直接子进程。
 */
function runCommand(command: string, workdir: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("任务已取消", "AbortError"));
      return;
    }
    const child = spawn(command, { shell: true, cwd: workdir, detached: true });
    const groupId = child.pid;
    if (groupId !== undefined) liveCommandGroups.add(groupId);

    const out = { text: "" };
    const err = { text: "" };
    let truncated = false;
    const collect = (chunk: Buffer, target: { text: string }): void => {
      if (truncated) return;
      if (target.text.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      target.text += chunk.toString();
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, out));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, err));

    let settled = false;
    let escalation: NodeJS.Timeout | undefined;

    /** 终止整棵进程树：先 SIGTERM，给命令一个自己收尾的机会；赖着不走再 SIGKILL 兜底。 */
    const killTree = (): void => {
      if (groupId === undefined) return;
      killCommandGroup(groupId, "SIGTERM");
      escalation = setTimeout(() => killCommandGroup(groupId, "SIGKILL"), KILL_ESCALATION_MS);
      escalation.unref();
    };

    /** 只认第一个结果：取消时 error 与 close 会先后到达，不能让 close 抢先 resolve 成假的「退出码」。 */
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      if (groupId !== undefined) liveCommandGroups.delete(groupId);
      action();
    };

    /** 取消：立刻以 AbortError 结束，不等子进程咽气 —— 用户按了取消就该马上回到待命状态。 */
    const onAbort = (): void => {
      killTree();
      settle(() => reject(new DOMException("任务已取消", "AbortError")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer = setTimeout(killTree, timeoutMs);
    timeoutTimer.unref();

    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() => {
        const output = `${out.text}${err.text}`.trim();
        const suffix = truncated ? "\n（输出过长已截断）" : "";
        resolve(output ? `退出码：${code ?? 1}\n${output}${suffix}` : `退出码：${code ?? 1}${suffix}`);
      }),
    );
  });
}

/** 创建当前 Agent 使用的内置工具。 */
export function createBuiltinTools(
  workdir: string,
  approveCommand: CommandApproval,
  options: CommandToolOptions = {},
): AgentTool[] {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return [
    {
      name: "list_files",
      description: "列出工作目录中的文件和目录",
      async execute(args: string[]): Promise<string> {
        const relativePath = args[0] || ".";
        const target = resolveSafePath(workdir, relativePath);
        if (!fs.statSync(target).isDirectory()) throw new Error(`不是目录：${relativePath}`);
        const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        return entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n") || "（空目录）";
      },
    },
    {
      name: "read_file",
      description: "读取工作目录内的文本文件",
      async execute(args: string[]): Promise<string> {
        const relativePath = args[0];
        if (!relativePath) throw new Error("read_file 缺少文件路径");
        const target = resolveSafePath(workdir, relativePath);
        if (!fs.statSync(target).isFile()) throw new Error(`不是文件：${relativePath}`);
        return fs.readFileSync(target, "utf8").slice(0, 20000);
      },
    },
    {
      name: "run_terminal_command",
      description: "在工作目录执行 shell 命令",
      async execute(args: string[], context: ToolContext): Promise<string> {
        const command = args.join("|");
        if (!command) throw new Error("run_terminal_command 缺少命令");
        // 审批与执行都带上取消信号：前者避免用户按 Ctrl+C 后仍被问答挂住，
        // 后者让已经在跑的命令被整棵杀掉，而不是等它自然结束。
        if (!(await approveCommand(command, context.signal))) return "用户拒绝执行该命令";
        return runCommand(command, workdir, context.signal, timeoutMs);
      },
    },
  ];
}
