import type { AppConfig } from "../types.ts";

/** 一次重试等待的可观察信息，用于上报事件与调试日志。 */
export interface RetryInfo {
  /** 即将发起的第几次尝试（从 1 开始）。 */
  attempt: number;
  /** 最大尝试次数。 */
  maxAttempts: number;
  /** 本次退避等待时长（毫秒）。 */
  delayMs: number;
  /** 触发重试的 HTTP 状态码；网络异常与超时时为空。 */
  status?: number;
  /** 触发重试的原因描述。 */
  reason: string;
}

/** 调用模型时的可选参数。 */
export interface CompleteOptions {
  /** 调用方取消信号，用于中断请求与重试等待。 */
  signal?: AbortSignal;
  /** 每次重试前回调，便于上层展示进度。 */
  onRetry?: (info: RetryInfo) => void;
}

/** 客户端可调参数，主要供测试缩短等待与预算。 */
export interface OpenAIClientOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  totalBudgetMs?: number;
  baseDelayMs?: number;
}

const DEFAULTS = {
  maxAttempts: 3,
  timeoutMs: 120_000,
  totalBudgetMs: 180_000,
  baseDelayMs: 1_000,
};

/**
 * 判断状态码是否值得重试：仅限流（429）与服务端临时故障（5xx）。
 * 其余状态码多为配置或参数错误，重试无意义且会拖慢报错。
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** 解析 Retry-After 响应头，兼容秒数与 HTTP 日期两种写法。 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

/** 等待指定时长，期间响应调用方取消。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("任务已取消", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("任务已取消", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 携带重试判定信息的内部失败，仅在本文件内流转。 */
class ModelRequestError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { retryable: boolean; status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "ModelRequestError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** 负责调用 OpenAI 兼容接口，并在可恢复失败时重试。 */
export class OpenAIClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly totalBudgetMs: number;
  private readonly baseDelayMs: number;

  /** 使用已校验的模型配置创建客户端。 */
  constructor(config: AppConfig, options: OpenAIClientOptions = {}) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.totalBudgetMs = options.totalBudgetMs ?? DEFAULTS.totalBudgetMs;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  }

  /**
   * 向模型发送上下文并返回文本回复。
   * 命中重试白名单的失败会退避重试，最多 maxAttempts 次；
   * 全部尝试与等待共享 totalBudgetMs 预算，超预算立即放弃。
   */
  async complete(messages: Array<Record<string, string>>, options: CompleteOptions = {}): Promise<string> {
    const deadline = Date.now() + this.totalBudgetMs;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        return await this.requestOnce(messages, options.signal, remaining);
      } catch (error) {
        const failure = error as Partial<ModelRequestError>;
        // 调用方取消与不可重试的失败：直接抛出，不做任何等待。
        if (!failure.retryable) throw error;
        lastError = error as Error;
        if (attempt >= this.maxAttempts) break;
        const delayMs = failure.retryAfterMs ?? this.baseDelayMs * 2 ** (attempt - 1);
        // 剩余预算不足以覆盖本次等待时直接放弃，避免用户长时间空等。
        if (Date.now() + delayMs > deadline) break;
        options.onRetry?.({
          attempt,
          maxAttempts: this.maxAttempts,
          delayMs,
          status: failure.status,
          reason: (error as Error).message,
        });
        await sleep(delayMs, options.signal);
      }
    }
    throw lastError ?? new Error(`模型接口在 ${this.totalBudgetMs}ms 预算内未返回结果（${this.baseUrl}）`);
  }

  /** 发起一次请求；失败时抛出带重试判定信息的错误。 */
  private async requestOnce(
    messages: Array<Record<string, string>>,
    callerSignal: AbortSignal | undefined,
    remainingBudgetMs: number,
  ): Promise<string> {
    // 单次超时不得超过剩余预算，否则重试会把总时长拖爆。
    const timeoutSignal = AbortSignal.timeout(Math.min(this.timeoutMs, remainingBudgetMs));
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, temperature: 0.2 }),
        signal,
      });
    } catch (error) {
      // 调用方主动取消：原样抛出，交由 Agent Loop 识别为任务取消，而非接口故障。
      if (callerSignal?.aborted) throw error;
      throw new ModelRequestError(`无法连接模型接口：${(error as Error).message}`, { retryable: true, cause: error });
    }
    const body = await response.text();
    if (!response.ok) {
      throw new ModelRequestError(`模型接口 HTTP ${response.status}（${this.baseUrl}）：${body || "响应为空"}`, {
        retryable: isRetryableStatus(response.status),
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      });
    }
    if (!body.trim()) throw new Error(`模型接口返回空响应（HTTP ${response.status}，${this.baseUrl}）。请检查 OPENAI_BASE_URL 是否填写为 API 根地址。`);
    let data: any;
    try {
      data = JSON.parse(body);
    } catch (error) {
      throw new Error(`模型接口返回的不是有效 JSON（HTTP ${response.status}，${this.baseUrl}）：${body.slice(0, 500).replace(/\n/g, "\\n")}`, { cause: error });
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`模型响应格式不正确：${JSON.stringify(data)}`);
    return content;
  }
}
