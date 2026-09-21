import fs from "node:fs";
import path from "node:path";

/**
 * 将 Agent 每一步的调试事件追加到 debug 目录中的 JSONL 文件。
 * 每行一个事件，既方便人工查看，也方便后续用脚本分析运行轨迹。
 */
export class DebugLogger {
  private readonly filePath: string;

  /** 创建本次任务的独立调试日志文件。 */
  constructor(workdir: string) {
    const debugDir = path.join(workdir, "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(debugDir, `agent-${timestamp}.jsonl`);
  }

  /** 记录一个结构化事件，不让日志写入失败影响 Agent 主流程。 */
  write(event: string, data: Record<string, unknown> = {}): void {
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...data,
      })}\n`, "utf8");
    } catch (error) {
      console.error(`调试日志写入失败：${(error as Error).message}`);
    }
  }

  /** 返回当前日志文件路径，便于启动时提示用户。 */
  getFilePath(): string { return this.filePath; }
}
