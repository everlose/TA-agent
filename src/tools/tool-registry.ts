import { UnknownToolError } from "../core/errors.ts";
import type { AgentTool, ToolContext } from "../types.ts";

/** 统一注册和执行工具，隔离 Agent Loop 与工具实现。 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  /** 注册一个工具并拒绝重复名称。 */
  register(tool: AgentTool): void {
    if (!tool?.name || typeof tool.execute !== "function") throw new Error("工具必须包含 name 和 execute");
    if (this.tools.has(tool.name)) throw new Error(`工具已注册：${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  /** 按名称查找工具。 */
  get(name: string): AgentTool {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(`未知工具：${name}`);
    return tool;
  }

  /** 执行工具并返回观察结果。 */
  async execute(name: string, args: string[], context: ToolContext): Promise<string> {
    return this.get(name).execute(args, context);
  }

  /**
   * 根据当前已注册工具生成提示词片段，避免工具注册表和提示词出现两套清单。
   * @returns {string} 可直接注入系统提示词的工具列表
   */
  describeForPrompt(): string {
    return [...this.tools.values()]
      .map((tool) => `- ${tool.name}：${tool.description}`)
      .join("\n");
  }
}
