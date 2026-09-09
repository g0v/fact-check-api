import type { Context, MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types/fact-check";

const ALLOWED_PRODUCTION_ORIGIN = "https://civic.vtaiwan.tw";

function isAllowedGetOrigin(origin: string): boolean {
  if (origin === ALLOWED_PRODUCTION_ORIGIN) return true;
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

export function setFactCheckGetCors(c: Context<ApiEnv>) {
  const origin = c.req.header("Origin");
  if (!origin || !isAllowedGetOrigin(origin)) return;
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
}

export const factCheckGetCors: MiddlewareHandler<ApiEnv> = async (c, next) => {
  await next();
  if (c.req.method === "GET") setFactCheckGetCors(c);
};
