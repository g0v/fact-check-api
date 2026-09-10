import type { Context, MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types/fact-check";

// 本站正式網域與呼叫本 API 的前端網域；兩者不同源，跨來源呼叫需要授權標頭。
const ALLOWED_PRODUCTION_ORIGINS = ["https://check.vtaiwan.tw", "https://civic.vtaiwan.tw"];

// 預檢結果的快取秒數；瀏覽器各自設有上限，超過的部分會被自行截短。
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

// 跨來源 JS 預設只讀得到 CORS 安全標頭；限流重試與診斷資訊需明確開放。
const EXPOSED_HEADERS = "Retry-After, X-Fact-Check-Cache, X-Request-Id";

// 議題 #29：允許 check.vtaiwan.tw、civic.vtaiwan.tw 與本機開發前端跨來源呼叫 /api/fact-check。
export function isAllowedCrossOrigin(origin: string): boolean {
  if (ALLOWED_PRODUCTION_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port !== ""
    );
  } catch {
    return false;
  }
}

// 回傳需要附上 CORS 授權標頭的來源；同源或不在允許清單內都回 null。
export function allowedCrossOrigin(c: Context<ApiEnv>): string | null {
  const origin = c.req.header("Origin");
  if (!origin || origin === new URL(c.req.url).origin) return null;
  return isAllowedCrossOrigin(origin) ? origin : null;
}

export function setFactCheckCors(c: Context<ApiEnv>) {
  const origin = allowedCrossOrigin(c);
  if (!origin) return;
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Expose-Headers", EXPOSED_HEADERS);
}

// 跨來源預檢回應；不提供 Access-Control-Allow-Credentials，端點不使用 cookie 或身分。
export function setFactCheckPreflightCors(c: Context<ApiEnv>, origin: string) {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SECONDS));
}

export const factCheckCors: MiddlewareHandler<ApiEnv> = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "POST") setFactCheckCors(c);
};
