import { Hono } from "hono";
import { factCheckRoutes } from "./routes/fact-check";
import type { ApiEnv } from "./types/fact-check";
import { setFactCheckCors } from "./middleware/cors";
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
  // 錯誤回應也要帶 CORS，否則跨來源前端只看得到不透明的網路錯誤，讀不到錯誤內容與 Retry-After。
  // 被擋下的來源例外：FORBIDDEN_ORIGIN 不得回授權標頭。
  if (
    (c.req.method === "GET" || c.req.method === "POST") &&
    new URL(c.req.url).pathname === "/api/fact-check" &&
    !(known && error.code === "FORBIDDEN_ORIGIN")
  )
    setFactCheckCors(c);
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
