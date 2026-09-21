#!/usr/bin/env node
/** 单文件 ReAct Agent 示例，配置从工作目录下的 config.json 读取。 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { exec } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** OpenAI 兼容接口所需的配置。 */
interface AgentConfig {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_BASE_URL: string;
}

/** 发送给模型的单条消息。 */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 工具函数统一接收字符串参数并返回文本结果。 */
type Tool = (...args: string[]) => Promise<string> | string;

/** 命令执行前的确认函数。 */
type Approval = (command: string) => Promise<boolean>;

/** 单文件示例使用的 ReAct 系统提示词。 */
const REACT_PROMPT = `你是本地项目编程助手。工作目录：{workdir}
严格使用以下格式回复：需要工具时输出 <thought>简短说明</thought><action>工具名|参数...</action>；完成时输出 <thought>简短总结</thought><final_answer>...</final_answer>。
工具：list_files|相对目录，read_file|相对文件，run_terminal_command|shell命令。
重要规则：一次只输出一个 action，并等待工具返回 observation 后再决定下一步。只有工具实际返回成功结果后，才能声称文件已创建、下载或保存。涉及本地文件、网络搜索或下载时，必须先调用工具；不能凭空声称已经完成。思考只写简短的可审计理由，不要虚构工具结果。`;

/** 最小可运行的 ReAct Agent，所有核心逻辑集中在一个类中。 */
class Agent {
  private readonly workdir: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly approval: Approval;
  private readonly tools: Record<string, Tool>;

  /** 读取配置并注册三个内置工具。 */
  constructor(workdir: string, approval: Approval) {
    this.workdir = path.resolve(workdir);
    this.approval = approval;
    const config = this.loadConfig();
    this.apiKey = config.OPENAI_API_KEY.trim();
    this.model = config.OPENAI_MODEL.trim();
    this.baseUrl = config.OPENAI_BASE_URL.trim().replace(/\/$/, "");
    this.tools = {
      list_files: (...args) => this.listFiles(...args),
      read_file: (...args) => this.readFile(...args),
      run_terminal_command: (...args) => this.runTerminalCommand(...args),
    };
  }

  /** 从工作目录读取并校验 config.json。 */
  private loadConfig(): AgentConfig {
    const configPath = path.join(this.workdir, "config.json");
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`找不到配置文件：${configPath}`);
      if (error instanceof SyntaxError) throw new Error(`配置文件不是有效 JSON：${configPath}`);
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`配置文件必须是 JSON 对象：${configPath}`);
    const config = value as Partial<AgentConfig>;
    const keys: Array<keyof AgentConfig> = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"];
    const missing = keys.filter((key) => typeof config[key] !== "string" || !config[key]?.trim());
    if (missing.length > 0) throw new Error(`配置文件缺少有效字段：${missing.join(", ")}`);
    return config as AgentConfig;
  }

  /** 调用 OpenAI 兼容的 Chat Completions 接口。 */
  private async callModel(messages: ChatMessage[]): Promise<string> {
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
    if (!body.trim()) throw new Error(`模型接口返回空响应（HTTP ${response.status}，${this.baseUrl}）`);
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch (error) {
      const preview = body.slice(0, 500).replace(/\n/g, "\\n");
      throw new Error(`模型接口返回的不是有效 JSON（HTTP ${response.status}）：${preview}`, { cause: error });
    }
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`模型响应格式不正确：${JSON.stringify(data)}`);
    return content;
  }

  /** 将相对路径解析到工作目录内，并拒绝越界路径。 */
  private safePath(value = "."): string {
    const target = path.resolve(this.workdir, value || ".");
    if (target !== this.workdir && !target.startsWith(`${this.workdir}${path.sep}`)) throw new Error("路径不能超出工作目录");
    return target;
  }

  /** 列出指定目录中的文件和子目录。 */
  private listFiles(relativePath = "."): string {
    const target = this.safePath(relativePath);
    if (!fs.statSync(target).isDirectory()) throw new Error(`不是目录：${relativePath}`);
    const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    return entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n") || "（空目录）";
  }

  /** 读取工作目录内的文本文件，最多返回 20000 个字符。 */
  private readFile(relativePath = ""): string {
    if (!relativePath) throw new Error("read_file 缺少文件路径");
    const target = this.safePath(relativePath);
    if (!fs.statSync(target).isFile()) throw new Error(`不是文件：${relativePath}`);
    return fs.readFileSync(target, "utf8").slice(0, 20000);
  }

  /** 经用户确认后，在工作目录执行 shell 命令。 */
  private async runTerminalCommand(...parts: string[]): Promise<string> {
    // action 使用竖线分隔参数，因此这里重新拼接命令中原有的管道符。
    const command = parts.join("|");
    if (!command) throw new Error("run_terminal_command 缺少命令");
    if (!(await this.approval(command))) return "用户拒绝执行该命令";
    try {
      const result = await execAsync(command, { cwd: this.workdir, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      const text = `${result.stdout}${result.stderr}`.trim();
      return text ? `退出码：0\n${text}` : "退出码：0";
    } catch (error) {
      const result = error as { code?: number | string; stdout?: string; stderr?: string };
      const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
      return text ? `退出码：${result.code ?? 1}\n${text}` : `退出码：${result.code ?? 1}`;
    }
  }

  /** 执行 ReAct 循环，直到模型给出最终答案。 */
  async run(userInput: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: REACT_PROMPT.replace("{workdir}", this.workdir) },
      { role: "user", content: `<question>${userInput}</question>` },
    ];
    let toolCallCount = 0;
    while (true) {
      const content = await this.callModel(messages);
      const thought = content.match(/<thought>(.*?)<\/thought>/s);
      if (thought) console.log(`\n💭 ${thought[1].trim()}`);
      // action 优先，防止同一回复中的未验证 final_answer 提前结束任务。
      const action = content.match(/<action>(.*?)<\/action>/s);
      if (action) {
        const parts = action[1].trim().split("|");
        const toolName = parts.shift()?.trim() || "";
        const args = parts.map((part) => part.trim());
        const tool = this.tools[toolName];
        if (!tool) throw new Error(`未知工具：${toolName}`);
        toolCallCount += 1;
        console.log(`\n🔧 ${toolName}(${args.join(", ")})`);
        let observation: string;
        try {
          observation = await tool(...args);
        } catch (error) {
          observation = `工具执行错误：${(error as Error).message}`;
        }
        console.log(`\n🔍 ${observation}`);
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: `<observation>${observation}</observation>` });
        continue;
      }
      const finalAnswer = content.match(/<final_answer>(.*?)<\/final_answer>/s);
      if (!finalAnswer) throw new Error("模型未输出 <action> 或 <final_answer>");
      console.log(toolCallCount > 0 ? `\n📋 工具调用审计：本轮实际调用 ${toolCallCount} 次` : "\n📋 工具调用审计：本轮没有实际调用工具");
      return finalAnswer[1].trim();
    }
  }
}

/** 只接受 y/Y 和 n/N，其余输入继续询问。 */
async function confirmCommand(rl: readline.Interface, _command: string): Promise<boolean> {
  while (true) {
    const answer = (await rl.question("是否执行此命令？输入 y/Y 执行，n/N 取消：")).trim();
    if (answer === "y" || answer === "Y") return true;
    if (answer === "n" || answer === "N") return false;
    console.log("请输入 y/Y 或 n/N。");
  }
}

/** 启动单文件 Agent 的交互式命令行。 */
async function main(): Promise<void> {
  const workdir = path.resolve(process.argv[2] || ".");
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error(`目录不存在：${workdir}`);
  const rl = readline.createInterface({ input, output, historySize: 1000 });
  try {
    const agent = new Agent(workdir, (command) => confirmCommand(rl, command));
    console.log(`Agent 已启动，工作目录：${workdir}\n输入任务，输入 quit 或 exit 退出。`);
    while (true) {
      const question = (await rl.question("\n你 > ")).trim();
      if (["quit", "exit"].includes(question.toLowerCase())) break;
      if (!question) continue;
      try {
        console.log(`\n🤖 ${await agent.run(question)}`);
      } catch (error) {
        console.error(`\n错误：${(error as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}

/** 捕获启动阶段异常并设置非零退出码。 */
try {
  await main();
} catch (error) {
  console.error(`错误：${(error as Error).message}`);
  process.exitCode = 1;
}
