import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import type { OpenAIClient } from "../src/model/openai-client.ts";
import type { AgentEventType, AgentTool } from "../src/types.ts";

/** 测试用工作目录：取自进程 cwd，本组用例不读写文件。 */
const WORKDIR = process.cwd();

/** 模型替身的 complete 签名，只保留本组用例关心的 signal。 */
type StubComplete = (
  messages: Array<Record<string, string>>,
  options?: { signal?: AbortSignal },
) => Promise<string>;

/** 用最小替身替换真实模型客户端，避免测试依赖网络。 */
function stubModel(complete: StubComplete): OpenAIClient {
  return { complete } as unknown as OpenAIClient;
}

/** 收集 Agent Loop 发布的事件类型，用于断言取消/完成路径。 */
function collectEvents(): { bus: EventBus; types: AgentEventType[] } {
  const bus = new EventBus();
  const types: AgentEventType[] = [];
  bus.subscribe((event) => types.push(event.type));
  return { bus, types };
}

/** 创建一个会记录调用次数的工具。 */
function countingTool(counter: { calls: number }, name = "noop"): AgentTool {
  return {
    name,
    description: "测试用工具",
    execute: (): string => {
      counter.calls += 1;
      return "ok";
    },
  };
}

describe("AgentLoop 取消", () => {
  it("模型调用期间取消：抛 AbortError、发布 task_cancelled、不执行工具", async () => {
    const counter = { calls: 0 };
    const tools = new ToolRegistry();
    tools.register(countingTool(counter));
    // 模拟真实的 fetch：挂起直到信号触发再以 AbortError 失败。
    const model = stubModel(
      (_messages, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("任务已取消", "AbortError")), { once: true });
        }),
    );
    const { bus, types } = collectEvents();
    const agent = new AgentLoop(model, tools, WORKDIR, bus, "session-cancel-in-flight", 20);
    const controller = new AbortController();

    const running = agent.run("做点什么", controller.signal);
    controller.abort();

    await assert.rejects(running, (error: Error) => error.name === "AbortError");
    assert.equal(counter.calls, 0);
    assert.ok(types.includes("task_cancelled"));
    assert.ok(!types.includes("tool_start"));
    assert.ok(!types.includes("task_failed"));
  });

  it("模型返回后、执行工具前取消：白捡的工具调用会被拦下", async () => {
    const counter = { calls: 0 };
    const tools = new ToolRegistry();
    tools.register(countingTool(counter));
    const controller = new AbortController();
    const model = stubModel(async () => {
      // 模拟「模型刚返回时用户按下 Ctrl+C」这一时间窗。
      controller.abort();
      return "<thought>算一下</thought><action>noop|x</action>";
    });
    const { bus, types } = collectEvents();
    const agent = new AgentLoop(model, tools, WORKDIR, bus, "session-cancel-after-model", 20);

    await assert.rejects(() => agent.run("做点什么", controller.signal), (error: Error) => error.name === "AbortError");
    assert.equal(counter.calls, 0);
    assert.ok(types.includes("task_cancelled"));
  });

  it("工具因取消失败：不降级成 observation，而是冒泡为任务取消", async () => {
    let receivedSignal: AbortSignal | undefined;
    const tools = new ToolRegistry();
    tools.register({
      name: "slow_tool",
      description: "挂起直到被取消的测试工具",
      execute: (_args, context) => {
        receivedSignal = context.signal;
        return new Promise<string>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new DOMException("任务已取消", "AbortError")), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const model = stubModel(async () => "<thought>跑一下</thought><action>slow_tool|x</action>");
    const { bus, types } = collectEvents();
    const agent = new AgentLoop(model, tools, WORKDIR, bus, "session-tool-cancel", 20);

    const running = agent.run("做点什么", controller.signal);
    // 等循环真正进入工具执行（工具已注册 abort 监听）之后再取消。
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await assert.rejects(running, (error: Error) => error.name === "AbortError");
    assert.equal(receivedSignal, controller.signal, "ToolContext 应当带上当前任务的取消信号");
    assert.ok(types.includes("tool_start"));
    // 关键回归：取消不能被当成「工具执行错误」回灌给模型，否则循环会带着假象继续跑。
    assert.ok(!types.includes("tool_result"));
    assert.ok(types.includes("task_cancelled"));
    assert.ok(!types.includes("task_failed"));
  });

  it("工具抛出的非 DOMException AbortError 同样算取消", async () => {
    // 真实场景：readline 的 question(signal) 取消时抛的是 Node 内部 AbortError，
    // 并不是 DOMException。曾经用 instanceof DOMException 判断，导致取消被
    // 降级成「工具执行错误」回灌给模型，循环多发一次请求才停（PTY 实测发现）。
    const tools = new ToolRegistry();
    tools.register({
      name: "approval_like_tool",
      description: "模拟审批问答被取消的测试工具",
      execute: () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
    });
    const modelCalls = { calls: 0 };
    const model = stubModel(async () => {
      modelCalls.calls += 1;
      return "<thought>跑一下</thought><action>approval_like_tool|x</action>";
    });
    const controller = new AbortController();
    const { bus, types } = collectEvents();
    const agent = new AgentLoop(model, tools, WORKDIR, bus, "session-plain-abort", 20);

    await assert.rejects(() => agent.run("做点什么", controller.signal), (error: Error) => error.name === "AbortError");

    assert.ok(!types.includes("tool_result"), "取消不应产生 observation");
    assert.ok(types.includes("task_cancelled"));
    assert.ok(!types.includes("task_failed"), "取消不能被判成任务失败");
    assert.equal(modelCalls.calls, 1, "取消后不应再发起模型请求");
  });

  it("信号在任务开始前就已取消：一次模型调用都不发", async () => {
    const modelCalls = { calls: 0 };
    const model = stubModel(async () => {
      modelCalls.calls += 1;
      return "<final_answer>不该被调用</final_answer>";
    });
    const controller = new AbortController();
    controller.abort();
    const { bus, types } = collectEvents();
    const agent = new AgentLoop(model, new ToolRegistry(), WORKDIR, bus, "session-abort-first", 20);

    await assert.rejects(() => agent.run("做点什么", controller.signal), (error: Error) => error.name === "AbortError");
    assert.equal(modelCalls.calls, 0);
    assert.ok(types.includes("task_cancelled"));
  });

  it("不传信号时正常跑完「一步工具 + 一步作答」", async () => {
    const counter = { calls: 0 };
    const tools = new ToolRegistry();
    tools.register(countingTool(counter));
    let step = 0;
    const model = stubModel(async () => {
      step += 1;
      return step === 1
        ? "<thought>先看看</thought><action>noop|x</action>"
        : "<thought>够了</thought><final_answer>完成</final_answer>";
    });
    const { bus, types } = collectEvents();
    const agent = new AgentLoop(model, tools, WORKDIR, bus, "session-happy-path", 20);

    assert.equal(await agent.run("做点什么"), "完成");
    assert.equal(counter.calls, 1);
    assert.ok(types.includes("tool_start"));
    assert.ok(types.includes("task_completed"));
    assert.ok(!types.includes("task_cancelled"));
  });
});
