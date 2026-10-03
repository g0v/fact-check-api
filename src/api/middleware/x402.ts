import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Network } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings, ApiEnv } from "../types/fact-check";

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

  if (hasCdpKeys) {
    return new HTTPFacilitatorClient({
      url,
      createAuthHeaders: cdpAuthHeaders(apiKeyId, apiKeySecret, url),
    });
  }

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
}

const middlewareCache = new WeakMap<ApiBindings, MiddlewareHandler<ApiEnv>>();

export function createX402PaymentMiddleware(env: ApiBindings): MiddlewareHandler<ApiEnv> {
  const cached = middlewareCache.get(env);
  if (cached) return cached;
  const payTo = requiredValue(env.PAY_TO, "PAY_TO");
  const network = requiredValue(env.X402_NETWORK, "X402_NETWORK") as Network;
  const price = requiredValue(env.X402_PRICE, "X402_PRICE");
  const facilitatorUrl = requiredValue(env.FACILITATOR_URL, "FACILITATOR_URL");
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
  const middleware = paymentMiddlewareFromConfig(
    routes,
    facilitator(env, facilitatorUrl),
    [{ network, server: new ExactEvmScheme() }],
    undefined,
    undefined,
    true,
  );
  middlewareCache.set(env, middleware);
  return middleware;
}

export const x402PaymentMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // Hono 會以 GET handler 處理 HEAD，但保留原始方法；必須在 SDK 前阻擋付款規則未涵蓋的 HEAD。
  if (c.req.method === "HEAD") {
    c.header("Allow", "GET, POST, OPTIONS");
    return c.body(null, 405);
  }
  if (c.req.method === "OPTIONS") return next();
  const middleware = createX402PaymentMiddleware(c.env);
  const paymentSignature = c.req.header("PAYMENT-SIGNATURE");
  const xPayment = c.req.header("X-PAYMENT");
  // 非空的 PAYMENT-SIGNATURE 永遠優先；X-PAYMENT 只承載同一種 v2 payload。
  if (!paymentSignature && xPayment) {
    // 收到的 Headers 可能不可變；替換 Request 的 headers，不 clone／tee 或讀取 body。
    const headers = new Headers(c.req.raw.headers);
    headers.set("PAYMENT-SIGNATURE", xPayment);
    c.req.raw = new Request(c.req.raw, { headers });
  }
  return middleware(c, next);
};
