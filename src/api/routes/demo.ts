import { Hono, type Context } from "hono";
import { allowedCrossOrigin, factCheckCors, setFactCheckPreflightCors } from "../middleware/cors";
import { forbiddenOrigin, postOriginGuard } from "../middleware/origin";
import { ipRateLimit } from "../middleware/rate-limit";
import type { ApiEnv } from "../types/fact-check";
import { ApiError } from "../utils/errors";

export const demoRoutes = new Hono<ApiEnv>();

// demo 是首頁使用的 facade；來源保護、CORS 與限流留在公開 API，查核流程交由 core service。
demoRoutes.use("/demo", factCheckCors);
demoRoutes.use("/demo", postOriginGuard);
demoRoutes.on(["GET", "POST"], "/demo", ipRateLimit);

function coreRequest(c: Context<ApiEnv>) {
  const coreUrl = new URL(c.req.url);
  coreUrl.pathname = "/fact-check";
  return new Request(coreUrl, c.req.raw);
}

async function proxyToCore(c: Context<ApiEnv>) {
  if (!c.env.FACT_CHECK_CORE)
    throw new ApiError("UPSTREAM_UNAVAILABLE", "查核核心服務暫時無法使用。", 502);
  try {
    return await c.env.FACT_CHECK_CORE.fetch(coreRequest(c));
  } catch {
    throw new ApiError("UPSTREAM_UNAVAILABLE", "查核核心服務暫時無法使用。", 502);
  }
}

demoRoutes.options("/demo", (c) => {
  const origin = allowedCrossOrigin(c);
  if (!origin) throw forbiddenOrigin();
  setFactCheckPreflightCors(c, origin);
  return c.body(null, 204);
});

demoRoutes.get("/demo", proxyToCore);
demoRoutes.post("/demo", proxyToCore);
