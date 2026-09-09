import { RATE_LIMIT } from "../config";

// 限流用 Durable Object：每個 IP key 一顆物件（idFromName 路由），
// 以記憶體中的「上次通過時間」判斷是否仍在冷卻視窗內，做精準的逐 IP 冷卻。
// 本 repo 只需要 per-key 冷卻，不需要 quota/capacity 功能。
// 物件閒置被回收後冷卻會提前結束；屬可接受的降級方向（寧可少擋，不可誤擋）。
export class RateLimiterDO {
  private lastAllowedMs = 0;

  async fetch(request: Request): Promise<Response> {
    const configuredWindowMs = Number(new URL(request.url).searchParams.get("window_ms"));
    const windowMs =
      Number.isFinite(configuredWindowMs) && configuredWindowMs > 0
        ? configuredWindowMs
        : RATE_LIMIT.windowMs;
    const now = Date.now();
    if (now - this.lastAllowedMs < windowMs) {
      return Response.json({ allowed: false });
    }
    this.lastAllowedMs = now;
    return Response.json({ allowed: true });
  }
}
