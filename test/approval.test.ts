import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
import { PassThrough } from "node:stream";
import { createApproval } from "../src/cli/approval.ts";
import type { CommandApproval } from "../src/types.ts";

/** readline 写出的提问前缀，用于判断「第几次提问已经发生」。 */
const PROMPT = "是否执行此命令？";

interface Harness {
  approve: CommandApproval;
  messages: string[];
  /** 等到第 promptCount 个提问被写出，避免抢在 question 注册之前喂输入。 */
  waitForPrompt: (promptCount: number) => Promise<void>;
  /** 喂入一行回答。 */
  type: (text: string) => void;
  close: () => void;
}

const active: Harness[] = [];

/** 出现次数，用于数读到了第几个提问。 */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 建一个不连接真实终端的审批环境。 */
function setup(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk: Buffer) => {
    transcript += chunk.toString();
  });
  const rl = readline.createInterface({ input, output });
  const messages: string[] = [];
  const harness: Harness = {
    approve: createApproval(rl, (message) => messages.push(message)),
    messages,
    waitForPrompt: async (promptCount) => {
      for (let i = 0; i < 500 && countOf(transcript, PROMPT) < promptCount; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(countOf(transcript, PROMPT) >= promptCount, `第 ${promptCount} 个提问未出现`);
    },
    type: (text) => {
      input.write(`${text}\n`);
    },
    close: () => {
      rl.close();
      input.destroy();
      output.destroy();
    },
  };
  active.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of active.splice(0)) harness.close();
});

describe("createApproval 命令审批", () => {
  it("输入 y 批准执行", async () => {
    const harness = setup();
    const pending = harness.approve("rm -rf /tmp/x", new AbortController().signal);

    await harness.waitForPrompt(1);
    harness.type("y");

    assert.equal(await pending, true);
  });

  it("输入 n 拒绝执行", async () => {
    const harness = setup();
    const pending = harness.approve("rm -rf /tmp/x");

    await harness.waitForPrompt(1);
    harness.type("n");

    assert.equal(await pending, false);
  });

  it("非 y/n 输入会提示并重新询问", async () => {
    const harness = setup();
    const pending = harness.approve("rm -rf /tmp/x");

    await harness.waitForPrompt(1);
    harness.type("也许吧");
    await harness.waitForPrompt(2);
    harness.type("Y");

    assert.equal(await pending, true);
    assert.deepEqual(harness.messages, ["请输入 y/Y 或 n/N。"]);
  });

  it("等待回答期间取消：立刻以 AbortError 失败，不必先回答 y/n", async () => {
    const harness = setup();
    const controller = new AbortController();
    const pending = harness.approve("rm -rf /tmp/x", controller.signal);

    await harness.waitForPrompt(1);
    controller.abort();

    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  });

  it("信号在提问前就已取消：直接失败", async () => {
    const harness = setup();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      harness.approve("rm -rf /tmp/x", controller.signal),
      (error: Error) => error.name === "AbortError",
    );
  });
});
