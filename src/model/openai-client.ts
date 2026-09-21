import type { AppConfig } from "../types.ts";

/** 负责调用 OpenAI 兼容接口，不参与 Agent Loop 或工具解析。 */
export class OpenAIClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  /** 使用已校验的模型配置创建客户端。 */
  constructor(config: AppConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
  }

  /** 向模型发送上下文并返回文本回复。 */
  async complete(messages: Array<Record<string, string>>): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, temperature: 0.2 }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
      throw new Error(`无法连接模型接口：${(error as Error).message}`, { cause: error });
    }
    const body = await response.text();
    if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}（${this.baseUrl}）：${body || "响应为空"}`);
    if (!body.trim()) throw new Error(`模型接口返回空响应（HTTP ${response.status}，${this.baseUrl}）。请检查 OPENAI_BASE_URL 是否填写为 API 根地址。`);
    let data: any;
    try { data = JSON.parse(body); } catch (error) {
      throw new Error(`模型接口返回的不是有效 JSON（HTTP ${response.status}，${this.baseUrl}）：${body.slice(0, 500).replace(/\n/g, "\\n")}`, { cause: error });
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`模型响应格式不正确：${JSON.stringify(data)}`);
    return content;
  }
}
