import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
import { PassThrough } from "node:stream";
import { CancellationController } from "../src/core/cancellation.ts";
import { bindInterrupts } from "../src/cli/interrupts.ts";

/** 一个已接线的测试环境：可手动触发 SIGINT，并观察输出与退出次数。 */
interface Harness {
  cancellation: CancellationController;
  messages: string[];
  exitCount: () => number;
  /** 模拟交互式终端下 Ctrl+C 触发的 Interface 级 SIGINT。 */
  rlSigint: () => void;
  /** 模拟外部 `kill -INT` 触发的进程级 SIGINT。 */
  processSigint: () => void;
  unbind: () => void;
  dispose: () => void;
}

const active: Harness[] = [];
const baselineListeners = process.listenerCount("SIGINT");

/** 建一个不连接真实终端的 readline，便于手动触发 SIGINT 事件。 */
function setup(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = readline.createInterface({ input, output });
  const cancellation = new CancellationController();
  const messages: string[] = [];
  let exits = 0;
  const unbind = bindInterrupts(cancellation, rl, () => { exits += 1; }, (message) => messages.push(message));
  const harness: Harness = {
    cancellation,
    messages,
    exitCount: () => exits,
    rlSigint: () => { rl.emit("SIGINT"); },
    processSigint: () => { process.emit("SIGINT"); },
    unbind,
    dispose: () => {
      unbind();
      rl.close();
      input.destroy();
      output.destroy();
    },
  };
  active.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of active.splice(0)) harness.dispose();
  // 监听器必须成对摘除，否则重复启动 CLI 会叠加中断处理。
  assert.equal(process.listenerCount("SIGINT"), baselineListeners, "测试不应泄漏 process 级 SIGINT 监听器");
});

describe("bindInterrupts 中断接线", () => {
  it("任务运行中按 Ctrl+C：只请求取消，不退出", () => {
    const harness = setup();
    const signal = harness.cancellation.start();

    harness.rlSigint();

    assert.equal(signal.aborted, true);
    assert.equal(harness.exitCount(), 0);
    assert.match(harness.messages[0], /已请求取消当前任务/);
  });

  it("已在取消中再按一次：强制退出，给出卡死任务的出口", () => {
    const harness = setup();
    harness.cancellation.start();

    harness.rlSigint();
    harness.rlSigint();

    assert.equal(harness.exitCount(), 1);
    assert.match(harness.messages[1], /强制退出/);
  });

  it("空闲时按 Ctrl+C：直接退出", () => {
    const harness = setup();

    harness.rlSigint();

    assert.equal(harness.exitCount(), 1);
    assert.match(harness.messages[0], /再见/);
  });

  it("外部 kill -INT 走进程级监听，语义与终端按键一致", () => {
    const harness = setup();
    const signal = harness.cancellation.start();

    harness.processSigint();

    assert.equal(signal.aborted, true);
    assert.equal(harness.exitCount(), 0);
    assert.match(harness.messages[0], /已请求取消当前任务/);
  });

  it("任务结束后回到空闲：下一次 Ctrl+C 判为退出而非取消", () => {
    const harness = setup();
    harness.cancellation.start();

    harness.rlSigint();
    harness.cancellation.finish();
    harness.rlSigint();

    assert.equal(harness.exitCount(), 1);
    assert.match(harness.messages[1], /再见/);
  });

  it("unbind 摘掉两级监听后，中断不再有任何效果", () => {
    const harness = setup();
    harness.cancellation.start();

    harness.unbind();
    harness.rlSigint();
    harness.processSigint();

    assert.equal(harness.exitCount(), 0);
    assert.equal(harness.messages.length, 0);
  });
});
