import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types/fact-check";
import { ApiError } from "../utils/errors";

export function forbiddenOrigin(): ApiError {
  return new ApiError("FORBIDDEN_ORIGIN", "POST 查核僅接受本站同源請求。", 403);
}

export const sameOriginPost: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.req.method === "POST") {
    // 瀏覽器 Origin 必須完全符合協定、主機與連接埠；不採用 Referer 或代理標頭替代。
    // 這是瀏覽器來源限制，非身分驗證；非瀏覽器程式仍能自行設定 Origin。
    const origin = c.req.header("Origin");
    if (origin !== new URL(c.req.url).origin) throw forbiddenOrigin();
  }
  await next();
};
