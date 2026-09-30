import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Network } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings, ApiEnv } from "../types/fact-check";

const DEFAULT_PAY_TO = "0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB";
const DEFAULT_NETWORK = "eip155:84532";
const DEFAULT_PRICE = "$0.05";
const DEFAULT_FACILITATOR_URL = "https://www.x402.org/facilitator";

const DESCRIPTION = (payTo: string, network: string, price: string) =>
  `這是 fact-check-api 的付費查核 API。每次呼叫收取 ${price} USDC，請將款項支付至 ${payTo}，使用 ${network} 網路。收到 402 回應後，依 PAYMENT-REQUIRED 內容產生 PAYMENT-SIGNATURE（或 X-PAYMENT）標頭，並以相同請求重試。`;

function configuredValue(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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

function facilitator(env: ApiBindings) {
  const url = configuredValue(env.FACILITATOR_URL, DEFAULT_FACILITATOR_URL);
  const authToken = configuredValue(env.FACILITATOR_AUTH_TOKEN, "");
  const apiKeyId = configuredValue(env.CDP_API_KEY_ID, "");
  const apiKeySecret = configuredValue(env.CDP_API_KEY_SECRET, "");
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
  const payTo = configuredValue(env.PAY_TO, DEFAULT_PAY_TO);
  const network = configuredValue(env.X402_NETWORK, DEFAULT_NETWORK) as Network;
  const price = configuredValue(env.X402_PRICE, DEFAULT_PRICE);
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
    facilitator(env),
    [{ network, server: new ExactEvmScheme() }],
    undefined,
    undefined,
    true,
  );
  middlewareCache.set(env, middleware);
  return middleware;
}

export const x402PaymentMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const middleware = createX402PaymentMiddleware(c.env);
  return middleware(c, next);
};
