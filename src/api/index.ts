import { Hono } from "hono";
import { factCheckRoutes } from "./routes/fact-check";
import type { ApiEnv } from "./types/fact-check";
import { setFactCheckGetCors } from "./middleware/cors";
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
  if (c.req.method === "GET" && new URL(c.req.url).pathname === "/api/fact-check")
    setFactCheckGetCors(c);
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
