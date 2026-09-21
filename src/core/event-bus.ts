import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventType } from "../types.ts";

/** 标准 Agent 事件的订阅回调。 */
export type AgentEventListener = (event: AgentEvent) => void;

/**
 * Agent 事件总线。
 * 负责给事件补充统一元数据并分发给 CLI、日志、测试等多个消费者。
 */
export class EventBus {
  private readonly listeners = new Set<AgentEventListener>();

  /** 注册一个事件监听器，并返回取消订阅函数。 */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 发布一条已经具备统一信封的 Agent 事件。 */
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** 创建并发布一条事件，避免业务代码重复填写时间和 ID。 */
  publish(params: {
    type: AgentEventType;
    taskId: string;
    sessionId: string;
    stepIndex?: number;
    message?: string;
    data?: Record<string, unknown>;
  }): AgentEvent {
    const event: AgentEvent = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      ...params,
    };
    this.emit(event);
    return event;
  }
}
