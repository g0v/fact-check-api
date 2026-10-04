import { Hono } from "hono";
import { demoRoutes } from "./routes/demo";
import { factCheckRoutes } from "./routes/fact-check";
import type { ApiEnv } from "./types/fact-check";
import { setFactCheckCors, setPaidFactCheckCors } from "./middleware/cors";
import { ApiError } from "./utils/errors";

export const api = new Hono<ApiEnv>();

api.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  c.header("Cache-Control", "no-store");
  await next();
});
api.onError((error, c) => {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  if (known && error.retryAfterSeconds) c.header("Retry-After", String(error.retryAfterSeconds));
  // 付費查核端點使用寬鬆 CORS；免費 demo 仍只允許既有來源清單。
  const pathname = new URL(c.req.url).pathname;
  if (
    (c.req.method === "GET" || c.req.method === "POST") &&
    !(known && error.code === "FORBIDDEN_ORIGIN")
  ) {
    if (["/api/fact-check", "/fact-check"].includes(pathname)) setPaidFactCheckCors(c);
    if (["/api/demo", "/demo"].includes(pathname)) setFactCheckCors(c);
  }
  console.info(
    JSON.stringify({
      event: "error",
      request_id: c.get("requestId"),
      status,
      stage: known ? error.stage : undefined,
    }),
  );
  return c.json(
    {
      status: "error",
      error: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "查核服務發生錯誤。",
      ...(known && error.stage ? { stage: error.stage } : {}),
      request_id: c.get("requestId"),
    },
    status,
  );
});
api.route("/", factCheckRoutes);
api.route("/", demoRoutes);
