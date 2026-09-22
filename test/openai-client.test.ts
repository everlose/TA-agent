import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAIClient } from "../src/model/openai-client.ts";
import type { RetryInfo } from "../src/model/openai-client.ts";

/** 测试用模型配置。 */
const CONFIG = { apiKey: "test-key", model: "test-model", baseUrl: "https://api.example.com/v1" };

/** 测试用消息。 */
const MESSAGES = [{ role: "user", content: "hi" }];

/** 一次成功响应，模型按协议输出了 final_answer。 */
const SUCCESS_BODY = JSON.stringify({ choices: [{ message: { content: "<thought>ok</thought><final_answer>done</final_answer>" } }] });

/** 单次假响应的描述：要么是 HTTP 响应，要么是网络异常。 */
type FakeStep = { status: number; body?: string; headers?: Record<string, string> } | { networkError: string };

/**
 * 安装一个按顺序返回响应的假 fetch。
 * 序列耗尽后重复最后一项，便于构造「持续失败」的场景。
 * @param steps 依次返回的响应描述
 * @returns 调用记录，长度为实际发出的请求次数
 */
function installFakeFetch(steps: FakeStep[]): { calls: Array<RequestInit | undefined> } {
  const calls: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(init);
    if ("networkError" in step) throw new TypeError(step.networkError);
    return new Response(step.body ?? "", { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  return { calls };
}

/** 直接接管 fetch，用于需要自定义行为的用例。 */
function installFetch(handler: () => Promise<Response>): { count: () => number } {
  let attempts = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    attempts += 1;
    return handler();
  }) as unknown as typeof fetch;
  return { count: () => attempts };
}

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("OpenAIClient 请求重试", () => {
  it("429 重试两次后成功，并按序上报重试信息", async () => {
    const { calls } = installFakeFetch([{ status: 429, body: "limited" }, { status: 429, body: "limited" }, { status: 200, body: SUCCESS_BODY }]);
    const retries: RetryInfo[] = [];
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1 });

    const content = await client.complete(MESSAGES, { onRetry: (info) => retries.push(info) });

    assert.match(content, /<final_answer>done<\/final_answer>/);
    assert.equal(calls.length, 3);
    assert.deepEqual(retries.map((info) => info.attempt), [1, 2]);
    assert.equal(retries[1].maxAttempts, 3);
    assert.equal(retries[0].status, 429);
  });

  it("持续 429 时达到尝试上限后抛错", async () => {
    const { calls } = installFakeFetch([{ status: 429, body: "limited" }]);
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1 });

    await assert.rejects(() => client.complete(MESSAGES), /HTTP 429/);
    assert.equal(calls.length, 3);
  });

  it("401 不在白名单内，只请求一次即报错", async () => {
    const { calls } = installFakeFetch([{ status: 401, body: "unauthorized" }]);
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1 });

    await assert.rejects(() => client.complete(MESSAGES), /HTTP 401/);
    assert.equal(calls.length, 1);
  });

  it("503 采信 Retry-After 响应头而非退避公式", async () => {
    // baseDelayMs 设为 50：若走退避公式延迟应为 50，采信响应头则为 0。
    const { calls } = installFakeFetch([{ status: 503, body: "down", headers: { "retry-after": "0" } }, { status: 200, body: SUCCESS_BODY }]);
    const retries: RetryInfo[] = [];
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 50 });

    await client.complete(MESSAGES, { onRetry: (info) => retries.push(info) });

    assert.equal(calls.length, 2);
    assert.equal(retries[0].delayMs, 0);
    assert.equal(retries[0].status, 503);
  });

  it("网络异常也会重试", async () => {
    const { calls } = installFakeFetch([{ networkError: "fetch failed" }, { status: 200, body: SUCCESS_BODY }]);
    const retries: RetryInfo[] = [];
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1 });

    const content = await client.complete(MESSAGES, { onRetry: (info) => retries.push(info) });

    assert.match(content, /final_answer/);
    assert.equal(calls.length, 2);
    assert.equal(retries[0].status, undefined);
    assert.match(retries[0].reason, /无法连接模型接口/);
  });

  it("请求超时按可重试处理", async () => {
    let first = true;
    const { count } = installFetch(async () => {
      if (first) {
        first = false;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response(SUCCESS_BODY, { status: 200 });
    });
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1 });

    const content = await client.complete(MESSAGES);

    assert.match(content, /final_answer/);
    assert.equal(count(), 2);
  });

  it("调用方取消时原样抛出 AbortError，不再重试", async () => {
    const controller = new AbortController();
    const { count } = installFetch(async () => {
      controller.abort();
      throw new DOMException("任务已取消", "AbortError");
    });
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1 });

    await assert.rejects(
      () => client.complete(MESSAGES, { signal: controller.signal }),
      (error: Error) => error.name === "AbortError",
    );
    assert.equal(count(), 1);
  });

  it("重试等待期间取消会中断等待，不再发起下一次请求", async () => {
    const controller = new AbortController();
    const { calls } = installFakeFetch([{ status: 429, body: "limited" }]);
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 5000 });

    await assert.rejects(
      () => client.complete(MESSAGES, { signal: controller.signal, onRetry: () => controller.abort() }),
      (error: Error) => error.name === "AbortError",
    );
    assert.equal(calls.length, 1);
  });

  it("退避等待超出总预算时直接放弃", async () => {
    // Retry-After 要求等 600 秒，远超 1 秒预算，应立刻放弃而不是真的等待。
    const { calls } = installFakeFetch([{ status: 429, body: "limited", headers: { "retry-after": "600" } }]);
    const client = new OpenAIClient(CONFIG, { baseDelayMs: 1, totalBudgetMs: 1000 });

    await assert.rejects(() => client.complete(MESSAGES), /HTTP 429/);
    assert.equal(calls.length, 1);
  });
});
