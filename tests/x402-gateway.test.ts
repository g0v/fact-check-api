import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { api } from "../src/api";
import type { ApiBindings, ServiceBindingLike } from "../src/api/types/fact-check";

const payTo = "0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB";
const network = "eip155:8453";
const facilitatorUrl = "https://facilitator.example.test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function coreBinding(handler: (request: Request) => Promise<Response>): ServiceBindingLike {
  return { fetch: vi.fn(handler) };
}

function environment(core: ServiceBindingLike, extra: Partial<ApiBindings> = {}): ApiBindings {
  return {
    FACT_CHECK_CORE: core,
    PAY_TO: payTo,
    X402_NETWORK: network,
    X402_PRICE: "$0.05",
    FACILITATOR_URL: facilitatorUrl,
    ...extra,
  };
}

function facilitatorFetch(options: { invalid?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/supported") {
      return Response.json({
        kinds: [{ x402Version: 2, scheme: "exact", network }],
        extensions: [],
      });
    }
    if (path === "/verify") {
      return Response.json(
        options.invalid ? { isValid: false, invalidReason: "付款驗證失敗。" } : { isValid: true },
      );
    }
    if (path === "/settle") {
      return Response.json({
        success: true,
        transaction: "0xsettled",
        network,
        payer: "0x0000000000000000000000000000000000000001",
      });
    }
    return new Response("找不到 facilitator 路徑。", { status: 404 });
  });
}

async function requiredPayment(core: ServiceBindingLike): Promise<PaymentRequired> {
  const response = await api.request(
    "/fact-check?text=%E6%B8%AC%E8%A9%A6%E4%B8%BB%E5%BC%B5",
    {},
    environment(core),
  );
  expect(response.status).toBe(402);
  const encoded = response.headers.get("PAYMENT-REQUIRED");
  expect(encoded).toBeTruthy();
  return decodePaymentRequiredHeader(encoded!);
}

function paymentHeader(required: PaymentRequired) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: required.accepts[0],
    payload: {
      signature: "0xsignature",
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: required.accepts[0].payTo,
        value: required.accepts[0].amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    },
  });
}

describe("/api/fact-check x402 閘門", () => {
  it("未付款回 402，提供 payTo、0.05 USDC、網路與繁中付款說明", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const required = await requiredPayment(core);

    expect(required.accepts[0]).toMatchObject({ payTo, network, amount: "50000" });
    expect(required.resource.description).toContain("每次呼叫收取 0.05 USDC");
    expect(required.resource.description).toContain(payTo);
    expect(required.resource.description).toContain(network);
    expect(required.resource.description).toContain("PAYMENT-SIGNATURE");
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("付費端點預檢允許付款標頭並 expose x402 回應標頭", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const response = await api.request(
      "/fact-check",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://browser.example.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,payment-signature",
        },
      },
      environment(core),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("PAYMENT-SIGNATURE");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-PAYMENT");
    expect(fetcher).not.toHaveBeenCalled();
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("有效付款後轉送 POST，GET 也轉成 core 的 POST JSON", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const coreRequests: Request[] = [];
    const core = coreBinding(async (request) => {
      coreRequests.push(request);
      return Response.json({ status: "completed" }, { headers: { "X-Fact-Check-Cache": "MISS" } });
    });
    const required = await requiredPayment(core);
    const header = paymentHeader(required);

    const postResponse = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": header },
        body: JSON.stringify({ text: "POST 主張", url: "https://example.com/a" }),
      },
      environment(core),
    );
    expect(postResponse.status).toBe(200);

    const getResponse = await api.request(
      "/fact-check?text=GET%20%E4%B8%BB%E5%BC%B5&url=https%3A%2F%2Fexample.com%2Fb",
      { headers: { "PAYMENT-SIGNATURE": header } },
      environment(core),
    );
    expect(getResponse.status).toBe(200);
    expect(coreRequests).toHaveLength(2);
    expect(coreRequests[0].method).toBe("POST");
    expect(await coreRequests[0].json()).toEqual({
      text: "POST 主張",
      url: "https://example.com/a",
    });
    expect(coreRequests[1].method).toBe("POST");
    expect(new URL(coreRequests[1].url).pathname).toBe("/fact-check");
    expect(await coreRequests[1].json()).toEqual({
      text: "GET 主張",
      url: "https://example.com/b",
    });
    expect(
      fetcher.mock.calls.filter(([request]) => String(request).endsWith("/verify")),
    ).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([request]) => String(request).endsWith("/settle")),
    ).toHaveLength(2);
  });

  it("每次呼叫都要付款，連續兩次未付款都回 402", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const first = await api.request("/fact-check?text=第一次", {}, environment(core));
    const second = await api.request("/fact-check?text=第二次", {}, environment(core));

    expect(first.status).toBe(402);
    expect(second.status).toBe(402);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("facilitator 驗證失敗時回 402，且不轉送 core", async () => {
    const fetcher = facilitatorFetch({ invalid: true });
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const required = await requiredPayment(core);
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": paymentHeader(required),
        },
        body: JSON.stringify({ text: "付款失敗" }),
      },
      environment(core),
    );

    expect(response.status).toBe(402);
    expect(core.fetch).not.toHaveBeenCalled();
  });
});
