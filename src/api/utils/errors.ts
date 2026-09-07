import type { UpstreamStage } from "../types/fact-check";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 403 | 413 | 429 | 500 | 502 | 503,
    public readonly stage?: UpstreamStage,
    // 部署設定錯誤（如缺少金鑰）不可視為暫時性上游不穩定而跳過。
    public readonly configError = false,
    // 用量達上限時建議重試的秒數，回應以 Retry-After 標頭告知。
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function upstreamError(stage: UpstreamStage, configError = false): ApiError {
  return new ApiError(
    "UPSTREAM_UNAVAILABLE",
    "查核上游服務暫時無法使用，請稍後再試。",
    502,
    stage,
    configError,
  );
}
