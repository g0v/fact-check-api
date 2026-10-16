import { RATE_LIMIT } from "../config";

const LAST_ALLOWED_MS_KEY = "lastAllowedMs";

export type RateLimiterStorageLike = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
};

export type RateLimiterStateLike = { storage: RateLimiterStorageLike };

// 限流用 Durable Object：每個 IP key 一顆物件（idFromName 路由），
// 持久化「上次通過時間」，讓物件閒置回收或重新啟動後仍維持逐 IP 冷卻。
// 本 repo 只需要 per-key 冷卻，不需要 quota/capacity 功能。
export class RateLimiterDO {
  constructor(private readonly state: RateLimiterStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const configuredWindowMs = Number(new URL(request.url).searchParams.get("window_ms"));
    const windowMs =
      Number.isFinite(configuredWindowMs) && configuredWindowMs > 0
        ? configuredWindowMs
        : RATE_LIMIT.windowMs;
    const allowed = await this.state.storage.transaction(async () => {
      const lastAllowedMs = await this.state.storage.get(LAST_ALLOWED_MS_KEY);
      // 儲存佇列可能延遲請求，讀取完成後再以目前時間判斷。
      const now = Date.now();
      if (lastAllowedMs !== undefined) {
        if (typeof lastAllowedMs !== "number" || !Number.isSafeInteger(lastAllowedMs)) {
          throw new Error("限流冷卻記錄格式錯誤。");
        }
        if (now - lastAllowedMs < windowMs) return false;
      }
      // 判斷與寫入在同一交易內；拒絕的請求不更新時間、不延長冷卻。
      await this.state.storage.put(LAST_ALLOWED_MS_KEY, now);
      return true;
    });
    return Response.json({ allowed });
  }
}
