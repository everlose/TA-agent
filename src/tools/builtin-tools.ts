import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool, ToolContext } from "../types.ts";

const execAsync = promisify(exec);

/** 将工具路径限制在工作目录内，避免访问工作区之外的文件。 */
function resolveSafePath(workdir: string, value = "."): string {
  const target = path.resolve(workdir, value || ".");
  if (target !== workdir && !target.startsWith(`${workdir}${path.sep}`)) throw new Error("路径不能超出工作目录");
  return target;
}

/** 创建当前 Agent 使用的内置工具。 */
export function createBuiltinTools(workdir: string, approveCommand: (command: string) => Promise<boolean>): AgentTool[] {
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
      async execute(args: string[], _context: ToolContext): Promise<string> {
        const command = args.join("|");
        if (!command) throw new Error("run_terminal_command 缺少命令");
        if (!(await approveCommand(command))) return "用户拒绝执行该命令";
        try {
          const result = await execAsync(command, { cwd: workdir, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
          const output = `${result.stdout}${result.stderr}`.trim();
          return output ? `退出码：0\n${output}` : "退出码：0";
        } catch (error) {
          const result = error as { stdout?: string; stderr?: string; code?: number | string };
          const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
          return output ? `退出码：${result.code ?? 1}\n${output}` : `退出码：${result.code ?? 1}`;
        }
      },
    },
  ];
}
