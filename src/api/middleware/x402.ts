import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Network } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings, ApiEnv } from "../types/fact-check";
import { claimVerifiedPayment, type ClaimedPayment } from "./payment-claim";
import { ApiError } from "../utils/errors";

const DESCRIPTION = (payTo: string, network: string, price: string) =>
  `這是 fact-check-api 的付費查核 API。每次呼叫收取 ${price} USDC，請將款項支付至 ${payTo}，使用 ${network} 網路。本 API 僅支援 x402 v2：收到 402 回應後，依 PAYMENT-REQUIRED 內容產生 PAYMENT-SIGNATURE，或以 X-PAYMENT 作為同一 v2 payload 的替代標頭，並以相同請求重試。`;

function configuredValue(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredValue(value: string | undefined, name: string): string {
  const configured = configuredValue(value);
  if (!configured) throw new Error(`付款設定 ${name} 不可缺少或為空白。`);
  return configured;
}

function isCdpFacilitatorUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return hostname === "api.cdp.coinbase.com" || hostname.endsWith(".cdp.coinbase.com");
  } catch {
    return false;
  }
}

function cdpAuthHeaders(apiKeyId: string, apiKeySecret: string, baseUrl: string) {
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const authorization = async (method: "GET" | "POST", path: string) => ({
    Authorization: `Bearer ${await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: method,
      requestHost: parsed.host,
      requestPath: path,
    })}`,
  });

  return async () => {
    const [verify, settle, supported] = await Promise.all([
      authorization("POST", `${basePath}/verify`),
      authorization("POST", `${basePath}/settle`),
      authorization("GET", `${basePath}/supported`),
    ]);
    return { verify, settle, supported };
  };
}

// HTTPFacilitatorClient 在 facilitator 回非 JSON／schema 不符時，會把上游回應本文
// 前 200 字元拼入例外訊息；SDK 又把該訊息原樣放進 PAYMENT-REQUIRED.error、
// PAYMENT-RESPONSE.errorReason/errorMessage 或 502 body。這些可能含 facilitator
// 反向代理或應用層的私有診斷。此 wrapper 只保留操作名與 HTTP 狀態碼，移除上游本文；
// facilitator 以 JSON 明確回覆的付款診斷（VerifyError／SettleError 的 invalidReason、
// errorReason 等）不經此路徑，維持原樣以保留必要交易識別。
function sanitizeFacilitatorError(error: unknown, operation: string): Error {
  if (
    error instanceof Error &&
    /^Facilitator (verify|settle|supported) (failed|returned invalid (JSON|data))/.test(
      error.message,
    )
  ) {
    const status = /\((\d+)\)/.exec(error.message)?.[1];
    const sanitized = status
      ? `Facilitator ${operation} failed (${status})`
      : `Facilitator ${operation} failed`;
    const wrapped = new Error(sanitized);
    wrapped.stack = error.stack;
    return wrapped;
  }
  return error instanceof Error ? error : new Error(`Facilitator ${operation} failed`);
}

// HTTPFacilitatorClient 介面：verify／settle／getSupported 三個呼叫點都需要去敏。
// 目標方法直接以 target 為 this 綁定，避免 Proxy receiver 造成內部欄位讀不到。
function sanitizeFacilitatorClient(client: HTTPFacilitatorClient): HTTPFacilitatorClient {
  return new Proxy(client, {
    get(target, property) {
      if (property !== "verify" && property !== "settle" && property !== "getSupported") {
        return Reflect.get(target, property);
      }
      const operation = property === "getSupported" ? "supported" : property;
      const original = (target[property] as (...callArgs: unknown[]) => unknown).bind(target);
      return async (...callArgs: unknown[]) => {
        try {
          return await original(...callArgs);
        } catch (error) {
          throw sanitizeFacilitatorError(error, operation);
        }
      };
    },
  });
}

function facilitator(env: ApiBindings, url: string) {
  const authToken = configuredValue(env.FACILITATOR_AUTH_TOKEN);
  const apiKeyId = configuredValue(env.CDP_API_KEY_ID);
  const apiKeySecret = configuredValue(env.CDP_API_KEY_SECRET);
  const hasApiKeyId = apiKeyId.length > 0;
  const hasApiKeySecret = apiKeySecret.length > 0;
  const hasCdpKeys = apiKeyId.length > 0 && apiKeySecret.length > 0;

  if (hasApiKeyId !== hasApiKeySecret) {
    throw new Error("CDP_API_KEY_ID 與 CDP_API_KEY_SECRET 必須同時設定。");
  }
  if (hasCdpKeys && authToken) {
    throw new Error("CDP JWT 與固定 facilitator Bearer token 不可同時設定。");
  }
  if (isCdpFacilitatorUrl(url) && !hasCdpKeys) {
    throw new Error("使用 Coinbase CDP facilitator 時必須設定完整的 CDP API key。");
  }
  const client = hasCdpKeys
    ? new HTTPFacilitatorClient({
        url,
        createAuthHeaders: cdpAuthHeaders(apiKeyId, apiKeySecret, url),
      })
    : (() => {
        const bearerHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
        return new HTTPFacilitatorClient({
          url,
          ...(bearerHeaders
            ? {
                createAuthHeaders: async () => ({
                  verify: bearerHeaders,
                  settle: bearerHeaders,
                  supported: bearerHeaders,
                }),
              }
            : {}),
        });
      })();
  return sanitizeFacilitatorClient(client);
}

type PaymentMiddlewareConfiguration = {
  middleware: MiddlewareHandler<ApiEnv>;
  client: HTTPFacilitatorClient;
};
const middlewareCache = new WeakMap<ApiBindings, PaymentMiddlewareConfiguration>();

function paymentConfiguration(env: ApiBindings): PaymentMiddlewareConfiguration {
  const cached = middlewareCache.get(env);
  if (cached) return cached;
  const payTo = requiredValue(env.PAY_TO, "PAY_TO");
  const network = requiredValue(env.X402_NETWORK, "X402_NETWORK") as Network;
  const price = requiredValue(env.X402_PRICE, "X402_PRICE");
  const facilitatorUrl = requiredValue(env.FACILITATOR_URL, "FACILITATOR_URL");
  if (!env.PAYMENT_CLAIM_DO) {
    throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "付款防重放服務未設定。", 500);
  }
  const routes = {
    "GET /fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network, price),
      mimeType: "application/json",
    },
    "POST /fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network, price),
      mimeType: "application/json",
    },
    "GET /api/fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network, price),
      mimeType: "application/json",
    },
    "POST /api/fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network, price),
      mimeType: "application/json",
    },
  };
  const client = facilitator(env, facilitatorUrl);
  const middleware = paymentMiddlewareFromConfig(
    routes,
    client,
    [{ network, server: new ExactEvmScheme() }],
    undefined,
    undefined,
    true,
  );
  const configuration = { middleware, client };
  middlewareCache.set(env, configuration);
  return configuration;
}

export function createX402PaymentMiddleware(env: ApiBindings): MiddlewareHandler<ApiEnv> {
  return paymentConfiguration(env).middleware;
}

export const x402PaymentMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // Hono 會以 GET handler 處理 HEAD，但保留原始方法；必須在 SDK 前阻擋付款規則未涵蓋的 HEAD。
  if (c.req.method === "HEAD") {
    c.header("Allow", "GET, POST, OPTIONS");
    return c.body(null, 405);
  }
  if (c.req.method === "OPTIONS") return next();
  const { middleware, client } = paymentConfiguration(c.env);
  const paymentSignature = c.req.header("PAYMENT-SIGNATURE");
  const xPayment = c.req.header("X-PAYMENT");
  // 非空的 PAYMENT-SIGNATURE 永遠優先；X-PAYMENT 只承載同一種 v2 payload。
  if (!paymentSignature && xPayment) {
    // 收到的 Headers 可能不可變；替換 Request 的 headers，不 clone／tee 或讀取 body。
    const headers = new Headers(c.req.raw.headers);
    headers.set("PAYMENT-SIGNATURE", xPayment);
    c.req.raw = new Request(c.req.raw, { headers });
  }
  let claim: ClaimedPayment | undefined;
  const result = await middleware(c, async () => {
    // SDK 只在付款通過 verify 後才進入受保護路由；先跨 isolate 原子 claim，再執行 core。
    claim = await claimVerifiedPayment(c.env, paymentSignature || xPayment, async (payment) => {
      const verification = await client.verify(payment, payment.accepted);
      return verification.isValid;
    });
    await next();
  });
  if (claim && c.res.status < 400) {
    try {
      // SDK 僅在結算成功後產生成功回應；占位必須涵蓋 core、本文讀取與完整 settle。
      const paymentResponse = c.res.headers.get("PAYMENT-RESPONSE");
      if (paymentResponse && decodePaymentResponseHeader(paymentResponse).success === true) {
        await claim.releaseReservation();
      }
    } catch {
      // 已結算的回應仍交付；無法確認釋放成功時保留占位至到期，不放行下一筆付款。
    }
  }
  return result;
};
