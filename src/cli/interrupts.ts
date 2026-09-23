import type readline from "node:readline/promises";
import type { CancellationController } from "../core/cancellation.ts";

/**
 * 把外部中断（CLI 的 Ctrl+C）接到取消控制器上，返回卸载函数。
 *
 * 同时监听 readline 与 process 两级，缺一不可：
 * - 交互式终端下 readline 接管了原始按键，Ctrl+C 由 Interface 的 SIGINT 事件给出；
 * - 非交互场景（管道输入、外部 `kill -INT`）按键不经过 readline，需要 process 级兜底。
 * 两者不会同时触发：readline 的原始模式关闭了终端的 ISIG，
 * 内核不会在按键时另发进程级 SIGINT。
 *
 * @param cancellation 取消控制器，负责裁决这次中断是取消任务还是退出
 * @param rl readline 实例，提供交互式终端的 SIGINT 事件
 * @param onExit 判定为退出时调用，由调用方决定如何收尾
 * @param log 输出通道，默认 stdout，便于测试替换
 * @returns 卸载函数，退出前移除监听，避免监听器叠加
 */
export function bindInterrupts(
  cancellation: CancellationController,
  rl: readline.Interface,
  onExit: () => void,
  log: (message: string) => void = console.log,
): () => void {
  const handle = (): void => {
    if (cancellation.interrupt() === "cancel") {
      log("\n⏹  已请求取消当前任务，等待当前请求结束…（再按一次 Ctrl+C 立即退出）");
      return;
    }
    // 此时仍在运行，说明是第二次按下：任务卡在无法打断的工具里，只能强制退出。
    log(cancellation.isRunning ? "\n⚠️  任务仍在运行，强制退出。" : "\n👋 再见。");
    onExit();
  };
  rl.on("SIGINT", handle);
  process.on("SIGINT", handle);
  return () => {
    rl.off("SIGINT", handle);
    process.off("SIGINT", handle);
  };
}
