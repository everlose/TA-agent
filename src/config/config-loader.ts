import fs from "node:fs";
import type { AppConfig } from "../types.ts";

/** 从工作目录读取并校验模型配置。 */
export function loadConfig(workdir: string): AppConfig {
  const configPath = `${workdir}/config.json`;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`找不到配置文件：${configPath}`);
    if (error instanceof SyntaxError) throw new Error(`配置文件不是有效 JSON：${configPath}`);
    throw error;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`配置文件必须是 JSON 对象：${configPath}`);
  const required = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"] as const;
  const missing = required.filter((key) => typeof config[key] !== "string" || !(config[key] as string).trim());
  if (missing.length) throw new Error(`配置文件缺少有效字段：${missing.join(", ")}`);
  return {
    apiKey: (config.OPENAI_API_KEY as string).trim(),
    model: (config.OPENAI_MODEL as string).trim(),
    baseUrl: (config.OPENAI_BASE_URL as string).trim().replace(/\/$/, ""),
  };
}
