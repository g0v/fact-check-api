import type { MiddlewareHandler } from "hono";
import { RATE_LIMIT } from "../config";
import type { ApiBindings } from "../types/fact-check";
import { ApiError } from "../utils/errors";

export function resolveRateLimitWindowMs(env: ApiBindings): number {
  const raw = env.RATE_LIMIT_WINDOW_MS;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : RATE_LIMIT.windowMs;
  if (typeof raw !== "string" || !raw.trim()) return RATE_LIMIT.windowMs;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : RATE_LIMIT.windowMs;
}

function rateLimitedError(windowMs: number): ApiError {
  // Retry-After 使用完整冷卻視窗，避免客戶端依標頭重試時仍落在限流期間。
  const retryAfterSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  return new ApiError(
    "RATE_LIMITED",
    "請求過於頻繁，請稍後再試。",
    429,
    undefined,
    false,
    retryAfterSeconds,
  );
}

// IPv6 收斂到 /64 前綴：避免攻擊者在同一 /64 段內輪換位址取得新額度。
// 回傳 null 代表無法解析的位址，交由上層保留原字串。
function normalizeIpv6Prefix64(ip: string): string | null {
  const zoneIndex = ip.indexOf("%");
  const withoutZone = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
  const [headPart, tailPart] = withoutZone.split("::");
  if (withoutZone.split("::").length > 2) return null;

  const parseParts = (part: string): string[] => {
    if (part === "") return [];
    return part.split(":");
  };

  const head = parseParts(headPart);
  const tail = tailPart === undefined ? [] : parseParts(tailPart);
  const expanded: string[] = [];
  for (const part of [...head, ...tail]) {
    if (part.includes(".")) return null; // IPv4-mapped 形式不處理
    const value = Number.parseInt(part, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(part) || !Number.isFinite(value)) return null;
  }

  if (tailPart === undefined) {
    if (head.length !== 8) return null;
    expanded.push(...head);
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    expanded.push(...head, ...Array.from({ length: missing }, () => "0"), ...tail);
  }

  return expanded
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(":");
}

// 以來源 IP 當限流 key：IPv4 用完整 IP；IPv6 收斂到 /64 前綴。
// 無法解析的位址保留原字串，仍可限流（寧可少擋，不可繞過）。
export function ipRateLimitKeyFromIp(ip: string): string {
  const normalized = ip.trim().toLowerCase();
  if (normalized.includes(":")) {
    const prefix64 = normalizeIpv6Prefix64(normalized);
    return prefix64 ? `ip6:${prefix64}::/64` : `ip:${normalized}`;
  }
  return `ip:${normalized}`;
}

// 兩層限流，任一層未綁定（本機 dev/測試）或檢查失敗時該層放行，絕不誤擋。
// 第一層：Cloudflare 內建 Rate Limiting binding，便宜、per-PoP，只擋明顯洪水。
// 第二層：Durable Object 精準冷卻（每 key 一顆，記憶體記「上次通過時間」）。
async function isRateLimited(env: ApiBindings, key: string, windowMs: number): Promise<boolean> {
  const limiter = (
    env as { RATE_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> } }
  ).RATE_LIMITER;
  if (limiter) {
    try {
      const { success } = await limiter.limit({ key });
      if (!success) return true;
    } catch (e) {
      console.error("內建限流檢查失敗，該層放行:", e);
    }
  }

  const ns = env.RATE_LIMIT_DO;
  if (!ns) return false;
  try {
    const stub = ns.get(ns.idFromName(key));
    const res = await stub.fetch(`https://rate-limit/?window_ms=${encodeURIComponent(windowMs)}`);
    if (!res.ok) throw new Error("限流服務回應失敗。");
    const data = (await res.json()) as { allowed?: unknown };
    if (typeof data.allowed !== "boolean") throw new Error("限流服務回應格式不正確。");
    return !data.allowed;
  } catch (e) {
    console.error("限流檢查失敗，放行:", e);
    return false;
  }
}

// /api/fact-check 沒有登入身分，只能以來源 IP 當限流 key（同一 NAT 會共用額度）。
// 取不到 cf-connecting-ip（本機 wrangler dev / Node 測試）時不限流，以免誤擋正常使用者。
export const ipRateLimit: MiddlewareHandler<{ Bindings: ApiBindings }> = async (c, next) => {
  const ip = c.req.header("cf-connecting-ip");
  const windowMs = resolveRateLimitWindowMs(c.env);
  if (ip && (await isRateLimited(c.env, ipRateLimitKeyFromIp(ip), windowMs)))
    throw rateLimitedError(windowMs);
  await next();
};
