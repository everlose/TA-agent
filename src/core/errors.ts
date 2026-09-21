/** Agent 运行时异常的基础类型。 */
export class AgentError extends Error {}
/** 模型输出无法解析时抛出的异常。 */
export class ProtocolError extends AgentError {}
/** Agent 超过最大循环次数时抛出的异常。 */
export class MaxStepsError extends AgentError {}
/** 工具名称不存在时抛出的异常。 */
export class UnknownToolError extends AgentError {}
