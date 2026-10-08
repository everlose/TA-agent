/** OpenAI 兼容接口所需的本地配置。 */
export interface AppConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Agent 工具定义。参数暂时沿用旧版的字符串数组协议。 */
export interface AgentTool {
  name: string;
  description: string;
  execute: (args: string[], context: ToolContext) => Promise<string> | string;
}

/** 危险命令的终端确认回调；signal 让审批问答本身也能被取消。 */
export type CommandApproval = (command: string, signal?: AbortSignal) => Promise<boolean>;

/** 工具执行时可获得的运行时上下文。 */
export interface ToolContext {
  workdir: string;
  /** 当前任务的取消信号。慢工具必须响应它，否则取消会被工具拖住。 */
  signal?: AbortSignal;
}

/** Agent Loop 向 CLI 发布的可观察事件。 */
export interface AgentEvent {
  eventId: string;
  type: AgentEventType;
  taskId: string;
  sessionId: string;
  stepIndex?: number;
  timestamp: number;
  message?: string;
  data?: Record<string, unknown>;
}

/** Agent 生命周期和执行过程中的标准事件类型。 */
export type AgentEventType =
  | "task_init"
  | "task_started"
  | "step_start"
  | "model_response"
  | "model_retry"
  | "thought"
  | "tool_approval_required"
  | "tool_start"
  | "tool_result"
  | "step_finish"
  | "task_completed"
  | "task_failed"
  | "task_cancelled";
