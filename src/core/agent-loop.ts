import { ContextManager } from "./context.ts";
import { MaxStepsError, ProtocolError, isAbortError } from "./errors.ts";
import { buildSystemPrompt } from "./prompt-builder.ts";
import { EventBus } from "./event-bus.ts";
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../tools/tool-registry.ts";
import type { OpenAIClient } from "../model/openai-client.ts";
import type { DebugLogger } from "./debug-logger.ts";

/** 执行 ReAct 循环，编排模型、上下文与工具之间的交互。 */
export class AgentLoop {
  private readonly model: OpenAIClient;
  private readonly tools: ToolRegistry;
  private readonly workdir: string;
  private readonly eventBus: EventBus;
  private readonly sessionId: string;
  private readonly maxSteps: number;
  private readonly debugLogger?: DebugLogger;
  private readonly systemPrompt: string;

  /** 创建 Agent Loop。 */
  constructor(
    model: OpenAIClient,
    tools: ToolRegistry,
    workdir: string,
    eventBus: EventBus,
    sessionId: string,
    maxSteps = 20,
    debugLogger?: DebugLogger,
  ) {
    this.model = model;
    this.tools = tools;
    this.workdir = workdir;
    this.eventBus = eventBus;
    this.sessionId = sessionId;
    this.maxSteps = maxSteps;
    this.debugLogger = debugLogger;
    // Agent Runtime 创建时只构建一次稳定提示词，后续任务直接复用它。
    this.systemPrompt = buildSystemPrompt(this.workdir, this.tools);
  }

  /** 执行一项用户任务，直到模型给出答案或达到最大步数。 */
  async run(question: string, signal?: AbortSignal): Promise<string> {
    const taskId = randomUUID();
    const context = new ContextManager(this.systemPrompt);
    context.addUserMessage(`<question>${question}</question>`);
    let toolCallCount = 0;
    this.publish("task_init", taskId, undefined, { question, maxSteps: this.maxSteps });
    this.publish("task_started", taskId, undefined, { question });
    this.debugLogger?.write("prompt:system", { taskId, sessionId: this.sessionId, systemPrompt: this.systemPrompt });
    let currentStep: number | undefined;
    try {
      for (let step = 1; step <= this.maxSteps; step += 1) {
        if (signal?.aborted) throw new DOMException("任务已取消", "AbortError");
        currentStep = step;
        this.publish("step_start", taskId, step, { toolCallCount });
        // 透传取消信号，并把重试进度按当前步上报，便于实时展示与事后复盘。
        const content = await this.model.complete(context.toMessages(), {
          signal,
          onRetry: (info): void => this.publish("model_retry", taskId, step, { ...info }),
        });
        this.publish("model_response", taskId, step, { content });
        const thought = content.match(/<thought>(.*?)<\/thought>/s);
        if (thought) this.publish("thought", taskId, step, { content: thought[1].trim() });
        const actionMatches = [...content.matchAll(/<action>(.*?)<\/action>/gs)];
        const final = content.match(/<final_answer>(.*?)<\/final_answer>/s);
        if (actionMatches.length === 0 && final) {
          const answer = final[1].trim();
          this.publish("step_finish", taskId, step, { reason: "final_answer", toolCallCount });
          this.publish("task_completed", taskId, undefined, { answer, toolCallCount });
          return answer;
        }
        if (actionMatches.length === 0) throw new ProtocolError("模型未输出 <action> 或 <final_answer>");
        const parts = actionMatches[0][1].trim().split("|");
        const toolName = parts.shift()?.trim() || "";
        const args = parts.map((part) => part.trim());
        // 模型调用期间用户可能刚好按下取消，这里再确认一次，避免白执行一个工具。
        if (signal?.aborted) throw new DOMException("任务已取消", "AbortError");
        toolCallCount += 1;
        this.publish("tool_start", taskId, step, { toolName, args });
        let observation: string;
        try {
          // 把取消信号交给工具：长命令与审批问答必须能被打断，否则取消会被工具拖住。
          observation = await this.tools.execute(toolName, args, { workdir: this.workdir, signal });
        } catch (error) {
          // 工具因取消而失败时绝不能降级成 observation：那会让循环带着「工具出错」
          // 的假象继续跑，用户按了 Ctrl+C 却发现停不下来。取消要原样向上冒泡。
          if (isAbortError(error)) throw error;
          observation = `工具执行错误：${(error as Error).message}`;
        }
        this.publish("tool_result", taskId, step, { toolName, args, observation });
        this.publish("step_finish", taskId, step, { reason: "tool_call", toolCallCount });
        context.addToolObservation(content, observation);
      }
      throw new MaxStepsError(`Agent 超过最大步数：${this.maxSteps}`);
    } catch (error) {
      if (isAbortError(error)) {
        if (currentStep !== undefined) this.publish("step_finish", taskId, currentStep, { reason: "cancelled", toolCallCount });
        this.publish("task_cancelled", taskId, undefined, { reason: "abort" });
      } else {
        if (currentStep !== undefined) this.publish("step_finish", taskId, currentStep, { reason: "error", toolCallCount });
        this.publish("task_failed", taskId, undefined, { message: (error as Error).message });
      }
      throw error;
    }
  }

  /** 发布统一事件，并同步写入调试日志。 */
  private publish(type: Parameters<EventBus["publish"]>[0]["type"], taskId: string, stepIndex: number | undefined, data: Record<string, unknown>): void {
    const event = this.eventBus.publish({ type, taskId, sessionId: this.sessionId, stepIndex, data });
    this.debugLogger?.write("event", event as unknown as Record<string, unknown>);
  }
}
