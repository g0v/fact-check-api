import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Network } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings, ApiEnv } from "../types/fact-check";

const DEFAULT_PAY_TO = "0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_PRICE = "$0.05";
const DEFAULT_FACILITATOR_URL = "https://www.x402.org/facilitator";

class StaticSupportFacilitatorClient extends HTTPFacilitatorClient {
  constructor(
    config: ConstructorParameters<typeof HTTPFacilitatorClient>[0],
    private readonly network: Network,
  ) {
    super(config);
  }

  override async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: this.network }],
      extensions: [],
    };
  }
}

const DESCRIPTION = (payTo: string, network: string) =>
  `這是 fact-check-api 的付費查核 API。每次呼叫收取 0.05 USDC，請將款項支付至 ${payTo}，使用 ${network} 網路。收到 402 回應後，依 PAYMENT-REQUIRED 內容產生 PAYMENT-SIGNATURE（或 X-PAYMENT）標頭，並以相同請求重試。`;

function configuredValue(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function facilitator(env: ApiBindings, network: Network) {
  const authToken = configuredValue(env.FACILITATOR_AUTH_TOKEN, "");
  const apiKeyId = configuredValue(env.CDP_API_KEY_ID, "");
  const apiKeySecret = configuredValue(env.CDP_API_KEY_SECRET, "");
  const hasCdpKeys = apiKeyId.length > 0 && apiKeySecret.length > 0;
  const authHeaders =
    authToken || hasCdpKeys
      ? {
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(hasCdpKeys
            ? {
                "x-api-key-id": apiKeyId,
                "x-api-key-secret": apiKeySecret,
              }
            : {}),
        }
      : undefined;

  return new StaticSupportFacilitatorClient(
    {
      url: configuredValue(env.FACILITATOR_URL, DEFAULT_FACILITATOR_URL),
      ...(authHeaders
        ? {
            createAuthHeaders: async () => ({
              verify: authHeaders,
              settle: authHeaders,
              supported: authHeaders,
            }),
          }
        : {}),
    },
    network,
  );
}

export function createX402PaymentMiddleware(env: ApiBindings): MiddlewareHandler<ApiEnv> {
  const payTo = configuredValue(env.PAY_TO, DEFAULT_PAY_TO);
  const network = configuredValue(env.X402_NETWORK, DEFAULT_NETWORK) as Network;
  const price = configuredValue(env.X402_PRICE, DEFAULT_PRICE);
  const routes = {
    "GET /fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network),
      mimeType: "application/json",
    },
    "POST /fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network),
      mimeType: "application/json",
    },
    "GET /api/fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network),
      mimeType: "application/json",
    },
    "POST /api/fact-check": {
      accepts: { scheme: "exact", payTo, price, network },
      description: DESCRIPTION(payTo, network),
      mimeType: "application/json",
    },
  };
  return paymentMiddlewareFromConfig(
    routes,
    facilitator(env, network),
    [{ network, server: new ExactEvmScheme() }],
    undefined,
    undefined,
    true,
  );
}

export const x402PaymentMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const middleware = createX402PaymentMiddleware(c.env);
  return middleware(c, next);
};
