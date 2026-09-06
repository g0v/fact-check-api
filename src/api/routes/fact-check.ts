import { Hono, type Context } from "hono";
import { LIMITS } from "../config";
import { forbiddenOrigin, sameOriginPost } from "../middleware/same-origin";
import { parseInput } from "../schemas/fact-check";
import { cachedFactCheck } from "../services/cached-fact-check";
import type { ApiEnv, FactCheckInput } from "../types/fact-check";
import { ApiError } from "../utils/errors";
import { readLimitedText, withTimeout } from "../utils/http";

export const factCheckRoutes = new Hono<ApiEnv>();

factCheckRoutes.use("/fact-check", sameOriginPost);

async function respond(c: Context<ApiEnv>, input: FactCheckInput) {
  let waitUntil: ((task: Promise<void>) => void) | undefined;
  try {
    const context = c.executionCtx;
    waitUntil = (task) => context.waitUntil(task);
  } catch {
    /* 一般 Node 單元測試沒有 Worker execution context。 */
  }
  const result = await cachedFactCheck(input, c.env, {
    origin: new URL(c.req.url).origin,
    requestId: c.get("requestId"),
    waitUntil,
  });
  c.header("X-Fact-Check-Cache", result.meta.cache!.status.toUpperCase());
  return c.json(result);
}

// 同源請求不需要 CORS 預檢；此端點不提供跨來源授權標頭。
factCheckRoutes.options("/fact-check", () => {
  throw forbiddenOrigin();
});

factCheckRoutes.get("/fact-check", async (c) => {
  if ((c.req.queries("text")?.length ?? 0) > 1 || (c.req.queries("url")?.length ?? 0) > 1) {
    throw new ApiError("INVALID_INPUT", "text 與 url 不得重複提供。", 400);
  }
  const input = parseInput({ text: c.req.query("text"), url: c.req.query("url") });
  return respond(c, input);
});

factCheckRoutes.post("/fact-check", async (c) => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError("INVALID_INPUT", "請使用 application/json 格式。", 400);
  }
  if (Number(c.req.header("content-length")) > LIMITS.requestBytes)
    throw new ApiError("PAYLOAD_TOO_LARGE", "請求內容過大。", 413);
  let raw: string;
  try {
    raw = await withTimeout(
      (signal) => readLimitedText(c.req.raw.body, LIMITS.requestBytes, signal),
      LIMITS.fetchTimeoutMs,
    );
  } catch {
    throw new ApiError("INVALID_INPUT", "請求內容過大、逾時或無法讀取。", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError("INVALID_INPUT", "JSON 格式不正確。", 400);
  }
  const input = parseInput(value);
  return respond(c, input);
});
