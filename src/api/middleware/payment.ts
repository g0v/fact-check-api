import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types/fact-check";
import { isMppEnabled, mppChallenge, mppCredential, mppPaymentMiddleware } from "./mpp";
import { x402PaymentMiddleware } from "./x402";
import { ApiError } from "../utils/errors";

// 付費查核入口：同一個 402 同時提供 x402（PAYMENT-REQUIRED）與 MPP（WWW-Authenticate: Payment）。
// client 只能擇一付款；帶 Authorization: Payment 走 MPP，其餘維持原本 x402 流程。
export const paymentMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const mppEnabled = isMppEnabled(c.env);
  const method = c.req.method;
  if (mppEnabled && (method === "GET" || method === "POST") && mppCredential(c)) {
    if (c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT")) {
      throw new ApiError("INVALID_PAYMENT", "請只使用一種付款方式（x402 或 MPP）。", 400);
    }
    return mppPaymentMiddleware(c, next);
  }

  const result = await x402PaymentMiddleware(c, next);
  const response = result ?? c.res;
  if (!mppEnabled || response.status !== 402) return result;

  // x402 回 402 時附上 MPP challenge；MPP 暫時無法使用不影響既有 x402 付款。
  let challenge: string | null = null;
  try {
    challenge = await mppChallenge(c);
  } catch {
    console.info(
      JSON.stringify({ event: "mpp_challenge_unavailable", request_id: c.get("requestId") }),
    );
  }
  if (!challenge) return result;
  const decorated = new Response(response.body, response);
  decorated.headers.append("WWW-Authenticate", challenge);
  if (result) return decorated;
  c.res = undefined;
  c.res = decorated;
};
