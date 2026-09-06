import type { UpstreamStage } from "../types/fact-check";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 413 | 500 | 502,
    public readonly stage?: UpstreamStage,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function upstreamError(stage: UpstreamStage): ApiError {
  return new ApiError("UPSTREAM_UNAVAILABLE", "查核上游服務暫時無法使用，請稍後再試。", 502, stage);
}
