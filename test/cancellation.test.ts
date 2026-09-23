import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CancellationController } from "../src/core/cancellation.ts";

describe("CancellationController", () => {
  it("start 返回未触发的信号并进入运行态", () => {
    const cancellation = new CancellationController();

    assert.equal(cancellation.isRunning, false);
    const signal = cancellation.start();

    assert.equal(signal.aborted, false);
    assert.equal(cancellation.isRunning, true);
    assert.equal(cancellation.isCancelling, false);
  });

  it("运行中首次中断只请求取消，信号触发但任务仍算运行中", () => {
    const cancellation = new CancellationController();
    const signal = cancellation.start();

    assert.equal(cancellation.interrupt(), "cancel");
    assert.equal(signal.aborted, true);
    assert.equal(cancellation.isCancelling, true);
    assert.equal(cancellation.isRunning, true);
  });

  it("空闲时中断判为退出", () => {
    assert.equal(new CancellationController().interrupt(), "exit");
  });

  it("取消后再次中断判为退出，作为卡死任务的强制出口", () => {
    const cancellation = new CancellationController();
    cancellation.start();

    assert.equal(cancellation.interrupt(), "cancel");
    assert.equal(cancellation.interrupt(), "exit");
  });

  it("finish 回到空闲态，且新任务拿到未触发的新信号", () => {
    const cancellation = new CancellationController();
    const first = cancellation.start();
    cancellation.interrupt();
    cancellation.finish();

    assert.equal(cancellation.isRunning, false);
    assert.equal(cancellation.isCancelling, false);
    assert.equal(cancellation.interrupt(), "exit");

    // 关键回归：AbortSignal 一旦 abort 就永久为 aborted，绝不能跨任务复用。
    const second = cancellation.start();
    assert.notEqual(second, first);
    assert.equal(second.aborted, false);
    assert.equal(cancellation.interrupt(), "cancel");
    assert.equal(second.aborted, true);
  });

  it("上个任务未结束时拒绝创建第二个信号", () => {
    const cancellation = new CancellationController();
    cancellation.start();

    assert.throws(() => cancellation.start(), /已有任务在运行/);
  });
});
