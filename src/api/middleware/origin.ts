import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types/fact-check";
import { ApiError } from "../utils/errors";
import { isAllowedCrossOrigin } from "./cors";

export function forbiddenOrigin(): ApiError {
  return new ApiError("FORBIDDEN_ORIGIN", "POST 查核僅接受本站或允許清單內的來源。", 403);
}

export const postOriginGuard: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.req.method === "POST") {
    // 瀏覽器 Origin 必須完全符合協定、主機與連接埠；不採用 Referer 或代理標頭替代。
    // 本站同源之外，只放行 middleware/cors.ts 允許清單內的跨來源（議題 #29）。
    // 這是瀏覽器來源限制，非身分驗證；非瀏覽器程式仍能自行設定 Origin。
    const origin = c.req.header("Origin");
    if (!origin || (origin !== new URL(c.req.url).origin && !isAllowedCrossOrigin(origin)))
      throw forbiddenOrigin();
  }
  await next();
};
