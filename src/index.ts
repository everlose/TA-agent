import { startCli } from "./cli/main.ts";

/** 启动程序，并将启动阶段错误转换为用户可读的命令行提示。 */
try {
  await startCli();
} catch (error) {
  console.error(`错误：${(error as Error).message}`);
  process.exitCode = 1;
}
