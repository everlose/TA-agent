import type readline from "node:readline/promises";
import type { CommandApproval } from "../types.ts";

/**
 * 创建危险命令的终端确认回调。
 *
 * 审批问答同样要响应取消：用户按 Ctrl+C 时任务应该立刻收尾，
 * 而不是被一个「是否执行此命令？」的问句挂住、必须先用 y/n 回答掉。
 * 这里把当前任务的取消信号交给 readline 的 question —— 取消时它直接以
 * AbortError 失败，异常向上冒泡成任务取消。
 *
 * @param rl readline 实例，提供 question 能力
 * @param log 输出通道，默认 stdout，便于测试替换
 */
export function createApproval(rl: readline.Interface, log: (message: string) => void = console.log): CommandApproval {
  return async (_command: string, signal?: AbortSignal): Promise<boolean> => {
    while (true) {
      // 只接受单个 y/Y 或 n/N，其他输入不会改变状态，避免误执行命令。
      const answer = (await rl.question("是否执行此命令？输入 y/Y 执行，n/N 取消：", { signal })).trim();
      if (answer === "y" || answer === "Y") return true;
      if (answer === "n" || answer === "N") return false;
      log("请输入 y/Y 或 n/N。");
    }
  };
}
