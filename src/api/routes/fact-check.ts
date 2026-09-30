import { Hono, type Context } from "hono";
import { LIMITS } from "../config";
import { setPaidFactCheckCors } from "../middleware/cors";
import { x402PaymentMiddleware } from "../middleware/x402";
import { parseInput } from "../schemas/fact-check";
import type { ApiEnv, FactCheckInput } from "../types/fact-check";
import { ApiError } from "../utils/errors";

export const factCheckRoutes = new Hono<ApiEnv>();

const paidCors = async (c: Context<ApiEnv>, next: () => Promise<void>) => {
  setPaidFactCheckCors(c);
  await next();
  setPaidFactCheckCors(c);
};

factCheckRoutes.use("/fact-check", paidCors);
factCheckRoutes.use("/fact-check", x402PaymentMiddleware);

function coreRequest(c: Context<ApiEnv>, input: FactCheckInput): Request {
  const coreUrl = new URL(c.req.url);
  coreUrl.pathname = "/fact-check";
  coreUrl.search = "";
  return new Request(coreUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function proxyToCore(c: Context<ApiEnv>, input: FactCheckInput): Promise<Response> {
  if (!c.env.FACT_CHECK_CORE)
    throw new ApiError("UPSTREAM_UNAVAILABLE", "查核核心服務暫時無法使用。", 502);
  try {
    return await c.env.FACT_CHECK_CORE.fetch(coreRequest(c, input));
  } catch {
    throw new ApiError("UPSTREAM_UNAVAILABLE", "查核核心服務暫時無法使用。", 502);
  }
}

factCheckRoutes.options("/fact-check", (c) => {
  setPaidFactCheckCors(c);
  return c.body(null, 204);
});

factCheckRoutes.get("/fact-check", async (c) => {
  const params = new URL(c.req.url).searchParams;
  if (params.getAll("text").length > 1 || params.getAll("url").length > 1) {
    throw new ApiError("INVALID_INPUT", "text 與 url 不得重複提供。", 400);
  }
  const input = parseInput({
    text: params.get("text") ?? undefined,
    url: params.get("url") ?? undefined,
  });
  return proxyToCore(c, input);
});

factCheckRoutes.post("/fact-check", async (c) => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError("INVALID_INPUT", "請使用 application/json 格式。", 400);
  }
  if (Number(c.req.header("content-length")) > LIMITS.requestBytes)
    throw new ApiError("PAYLOAD_TOO_LARGE", "請求內容過大。", 413);
  let raw: string;
  try {
    raw = await c.req.text();
    if (new TextEncoder().encode(raw).byteLength > LIMITS.requestBytes)
      throw new Error("請求內容過大。");
  } catch {
    throw new ApiError("INVALID_INPUT", "請求內容過大或無法讀取。", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError("INVALID_INPUT", "JSON 格式不正確。", 400);
  }
  const input = parseInput(value);
  return proxyToCore(c, input);
});
