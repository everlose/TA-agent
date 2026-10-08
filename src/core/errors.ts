/** Agent 运行时异常的基础类型。 */
export class AgentError extends Error {}
/** 模型输出无法解析时抛出的异常。 */
export class ProtocolError extends AgentError {}
/** Agent 超过最大循环次数时抛出的异常。 */
export class MaxStepsError extends AgentError {}
/** 工具名称不存在时抛出的异常。 */
export class UnknownToolError extends AgentError {}

/**
 * 判断一个异常是否代表「任务被取消」。
 *
 * 只能按 name 判断，不能 `instanceof DOMException`：取消来源不止一种，
 * 抛出的类型也不统一 —— fetch 与 spawn 给的是 DOMException，
 * 而 readline 的 question(signal) 给的是 Node 内部的 AbortError（并非 DOMException）。
 * 用 instanceof 会漏判，把取消误当成工具故障。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
