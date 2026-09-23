/**
 * 任务取消控制器。
 *
 * Agent Loop 本身只会「读」取消信号，信号的创建与触发必须有唯一入口，
 * 否则取消能力就只是躺在库里的死代码。本类承担这个入口：
 * 为每个任务分配一个 AbortController，并把外部中断（CLI 的 Ctrl+C）
 * 翻译成明确的两级语义。
 */

/** 一次中断的处理结论：取消当前任务，或退出程序。 */
export type InterruptAction = "cancel" | "exit";

/** 管理当前任务的取消信号，并裁决中断事件的归属。 */
export class CancellationController {
  private current: AbortController | null = null;
  private cancelling = false;

  /** 是否有任务正在运行。 */
  get isRunning(): boolean {
    return this.current !== null;
  }

  /** 任务是否已收到取消请求、但尚未真正停下。 */
  get isCancelling(): boolean {
    return this.cancelling;
  }

  /**
   * 为一个新任务创建取消信号。
   * 同一时刻只允许一个任务，避免两个任务的取消信号互相覆盖。
   */
  start(): AbortSignal {
    if (this.current) throw new Error("已有任务在运行，不能重复创建取消信号");
    this.current = new AbortController();
    this.cancelling = false;
    return this.current.signal;
  }

  /**
   * 任务结束（完成 / 失败 / 已取消）后回到空闲态。
   * 必须调用：AbortSignal 一旦 abort 就永久为 aborted，绝不能让下个任务复用它。
   */
  finish(): void {
    this.current = null;
    this.cancelling = false;
  }

  /**
   * 处理一次中断，返回调用方应执行的动作。
   *
   * 分级语义：第一次中断命中运行中的任务时只请求取消，给 Agent 收尾的机会；
   * 空闲时中断，或任务已在取消中再次中断（例如卡在无法打断的工具里），
   * 才判为退出。
   */
  interrupt(): InterruptAction {
    if (this.current && !this.cancelling) {
      this.cancelling = true;
      this.current.abort();
      return "cancel";
    }
    return "exit";
  }
}
