/** 管理一次 Agent 任务的消息上下文，为后续摘要和裁剪预留边界。 */
export class ContextManager {
  private readonly messages: Array<Record<string, string>>;

  /** 使用系统提示词初始化上下文。 */
  constructor(systemPrompt: string) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  /** 添加用户消息。 */
  addUserMessage(content: string): void { this.messages.push({ role: "user", content }); }

  /** 添加模型回复和工具观察结果。 */
  addToolObservation(assistantContent: string, observation: string): void {
    this.messages.push({ role: "assistant", content: assistantContent });
    this.messages.push({ role: "user", content: `<observation>${observation}</observation>` });
  }

  /** 返回上下文副本，避免模型客户端修改内部状态。 */
  toMessages(): Array<Record<string, string>> { return structuredClone(this.messages); }
}
