import { createServer } from "node:http";
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { api } from "../src/api";
import app from "../src/index";
import type { ApiBindings, ServiceBindingLike } from "../src/api/types/fact-check";
import { paymentClaimNamespace } from "./fixtures/payment-claim";

const payTo = "0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB";
const network = "eip155:8453";
const facilitatorUrl = "https://facilitator.example.test";
const cdpFacilitatorUrl = "https://api.cdp.coinbase.com/platform/v2/x402";
const cdpApiKeyId = "test-cdp-key-id";
// RFC 8032 Ed25519 測試向量，只用來驗證 JWT 結構，並非可用 credential。
const cdpApiKeySecret = Buffer.from(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "hex",
).toString("base64");

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
    PAYMENT_CLAIM_DO: paymentClaimNamespace(),
    PAY_TO: payTo,
    X402_NETWORK: network,
    X402_PRICE: "$0.05",
    FACILITATOR_URL: facilitatorUrl,
    ...extra,
  };
}

function facilitatorFetch(
  options: {
    invalid?: boolean;
    invalidSignature?: string;
    onRequest?: (path: string) => void;
    settleFailure?: "reject" | "throw";
  } = {},
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    options.onRequest?.(path);
    if (path.endsWith("/supported")) {
      return Response.json({
        kinds: [{ x402Version: 2, scheme: "exact", network }],
        extensions: [],
      });
    }
    if (path.endsWith("/verify")) {
      const body = (await request.json()) as {
        paymentPayload?: { payload?: { signature?: string } };
      };
      const invalidSignature =
        options.invalidSignature !== undefined &&
        body.paymentPayload?.payload?.signature === options.invalidSignature;
      return Response.json(
        options.invalid || invalidSignature
          ? { isValid: false, invalidReason: "付款驗證失敗。" }
          : { isValid: true },
      );
    }
    if (path.endsWith("/settle")) {
      if (options.settleFailure === "throw") throw new Error("結算連線中斷，付款結果不明。");
      if (options.settleFailure === "reject") {
        return Response.json({ success: false, errorReason: "結算失敗。", network });
      }
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

function paymentHeader(
  required: PaymentRequired,
  signature = "0xsignature",
  nonce = "0x0000000000000000000000000000000000000000000000000000000000000000",
) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: required.accepts[0],
    payload: {
      signature,
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: required.accepts[0].payTo,
        value: required.accepts[0].amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce,
      },
    },
  });
}

function jwtClaims(request: Request) {
  const authorization = request.headers.get("Authorization");
  expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const token = authorization!.slice("Bearer ".length);
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
    sub: string;
    uris: string[];
    iat: number;
    exp: number;
  };
}

describe("/api/fact-check x402 閘門", () => {
  it("未付款回 402，提供 payTo、0.05 USDC、網路與繁中付款說明", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const required = await requiredPayment(core);

    expect(required.accepts[0]).toMatchObject({ payTo, network, amount: "50000" });
    expect(required.resource.description).toContain("每次呼叫收取 $0.05 USDC");
    expect(required.resource.description).toContain(payTo);
    expect(required.resource.description).toContain(network);
    expect(required.resource.description).toContain("PAYMENT-SIGNATURE");
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("同一付款並發十次，跨環境、GET／POST 與付款標頭只執行一次 core", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    let releaseCore!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseCore = resolve;
    });
    let allDecided!: () => void;
    const decisions = new Promise<void>((resolve) => {
      allDecided = resolve;
    });
    let decisionCount = 0;
    const noteDecision = () => {
      if (++decisionCount === 10) allDecided();
    };
    const core = coreBinding(async () => {
      noteDecision();
      await barrier;
      return Response.json({ status: "completed" });
    });
    const namespace = paymentClaimNamespace();
    const required = await requiredPayment(core);
    const signature = paymentHeader(required);
    const pending = Array.from({ length: 10 }, async (_, index) => {
      const response = await app.request(
        index % 2 ? "/api/fact-check?text=並發查核" : "/api/fact-check",
        index % 2
          ? { headers: { "X-PAYMENT": signature } }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": signature },
              body: JSON.stringify({ text: "並發查核" }),
            },
        environment(core, { PAYMENT_CLAIM_DO: namespace }),
      );
      noteDecision();
      return response;
    });
    try {
      await decisions;
      expect(core.fetch).toHaveBeenCalledTimes(1);
      expect(
        fetcher.mock.calls.filter(([input]) => String(input).endsWith("/verify")),
      ).toHaveLength(10);
      expect(
        fetcher.mock.calls.filter(([input]) => String(input).endsWith("/settle")),
      ).toHaveLength(0);
    } finally {
      releaseCore();
    }
    const responses = await Promise.all(pending);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(conflicts).toHaveLength(9);
    for (const response of conflicts) {
      expect(await response.json()).toMatchObject({ error: "PAYMENT_ALREADY_CLAIMED" });
      expect(response.headers.has("PAYMENT-RESPONSE")).toBe(false);
    }
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/settle"))).toHaveLength(
      1,
    );
    const replay = await app.request(
      "/api/fact-check?text=重放",
      { headers: { "PAYMENT-SIGNATURE": signature } },
      environment(core, { PAYMENT_CLAIM_DO: namespace }),
    );
    expect(replay.status).toBe(409);
    expect(core.fetch).toHaveBeenCalledTimes(1);
    const fresh = await app.request(
      "/api/fact-check?text=新的授權",
      {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader(required, "0xfresh", `0x${"01".repeat(32)}`),
        },
      },
      environment(core, { PAYMENT_CLAIM_DO: namespace }),
    );
    expect(fresh.status).toBe(200);
    expect(core.fetch).toHaveBeenCalledTimes(2);
  });

  it("改寫 JSON 排序、簽章、nonce 大小寫或資源描述不能繞過同一 authorization 的 claim", async () => {
    vi.stubGlobal("fetch", facilitatorFetch());
    const core = coreBinding(async () => Response.json({ status: "completed" }));
    const env = environment(core);
    const required = await requiredPayment(core);
    const signature = paymentHeader(required, "0xfirst", `0x${"ab".repeat(32)}`);
    const first = await api.request(
      "/fact-check?text=第一次",
      { headers: { "PAYMENT-SIGNATURE": signature } },
      env,
    );
    expect(first.status).toBe(200);
    const decoded = decodePaymentSignatureHeader(signature);
    const authorization = decoded.payload.authorization as Record<string, string>;
    const altered = Buffer.from(
      JSON.stringify({
        payload: {
          authorization: { ...authorization, nonce: `0x${"AB".repeat(32)}` },
          signature: "0xother-signature",
        },
        resource: { url: "https://example.test/other", description: "不同查核主張" },
        accepted: decoded.accepted,
        x402Version: 2,
      }),
    ).toString("base64");
    const replay = await api.request(
      "/fact-check?text=不同主張",
      { headers: { "X-PAYMENT": altered } },
      env,
    );
    expect(replay.status).toBe(409);
    expect(core.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["core 回 502", "core 拋例外", "settle 失敗", "settle 連線中斷"])(
    "%s 後不釋放付款 claim",
    async (failure) => {
      const fetcher = facilitatorFetch({
        settleFailure:
          failure === "settle 失敗"
            ? "reject"
            : failure === "settle 連線中斷"
              ? "throw"
              : undefined,
      });
      vi.stubGlobal("fetch", fetcher);
      const core = coreBinding(async () => {
        if (failure === "core 拋例外") throw new Error("核心連線中斷。");
        return Response.json(
          { status: failure === "core 回 502" ? "error" : "completed" },
          { status: failure === "core 回 502" ? 502 : 200 },
        );
      });
      const env = environment(core);
      const signature = paymentHeader(await requiredPayment(core));
      const request = () =>
        api.request(
          "/fact-check?text=失敗重放",
          { headers: { "PAYMENT-SIGNATURE": signature } },
          env,
        );
      const first = await request();
      expect(first.status).toBeGreaterThanOrEqual(400);
      expect((await request()).status).toBe(409);
      expect(core.fetch).toHaveBeenCalledTimes(1);
      expect(
        fetcher.mock.calls.filter(([input]) => String(input).endsWith("/settle")),
      ).toHaveLength(failure.startsWith("settle") ? 1 : 0);
    },
  );

  it.each(["未綁定", "連線失敗", "錯誤狀態", "無效回應"])(
    "claim 服務%s 時 fail closed",
    async (failure) => {
      vi.stubGlobal("fetch", facilitatorFetch());
      const core = coreBinding(async () => Response.json({ status: "completed" }));
      const namespace =
        failure === "未綁定"
          ? undefined
          : {
              idFromName: (name: string) => name,
              get: () => ({
                fetch: async () => {
                  if (failure === "連線失敗") throw new Error("claim 連線失敗。");
                  return failure === "錯誤狀態"
                    ? new Response(null, { status: 503 })
                    : Response.json({ claimed: "true" });
                },
              }),
            };
      const signature = paymentHeader(await requiredPayment(core));
      const response = await api.request(
        "/fact-check?text=不可放行",
        { headers: { "PAYMENT-SIGNATURE": signature } },
        environment(core, { PAYMENT_CLAIM_DO: namespace }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "PAYMENT_CLAIM_UNAVAILABLE" });
      expect(core.fetch).not.toHaveBeenCalled();
    },
  );

  it("驗證失敗不占用 claim，之後同 nonce 的有效付款仍可查核", async () => {
    const core = coreBinding(async () => Response.json({ status: "completed" }));
    const env = environment(core);
    const get = vi.spyOn(env.PAYMENT_CLAIM_DO!, "get");
    vi.stubGlobal("fetch", facilitatorFetch({ invalidSignature: "0xinvalid" }));
    const required = await requiredPayment(core);
    const invalid = await api.request(
      "/fact-check?text=無效付款",
      { headers: { "PAYMENT-SIGNATURE": paymentHeader(required, "0xinvalid") } },
      env,
    );
    expect(invalid.status).toBe(402);
    expect(get).not.toHaveBeenCalled();
    const valid = await api.request(
      "/fact-check?text=有效付款",
      { headers: { "PAYMENT-SIGNATURE": paymentHeader(required, "0xvalid") } },
      env,
    );
    expect(valid.status).toBe(200);
    expect(core.fetch).toHaveBeenCalledTimes(1);
  });

  it("授權過期後即使 facilitator 仍回有效，也不能在 TTL 清理後進入 core", async () => {
    vi.stubGlobal("fetch", facilitatorFetch());
    const core = coreBinding(async () => Response.json({ status: "completed" }));
    const env = environment(core);
    const signature = paymentHeader(await requiredPayment(core));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 360_000);
    const response = await api.request(
      "/fact-check?text=過期重放",
      { headers: { "PAYMENT-SIGNATURE": signature } },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_PAYMENT" });
    expect(core.fetch).not.toHaveBeenCalled();
  });

  describe.each(["PAY_TO", "X402_NETWORK", "X402_PRICE", "FACILITATOR_URL"] as const)(
    "必要付款設定 %s",
    (key) => {
      it.each([
        ["未設定", undefined],
        ["空字串", ""],
        ["純空白", " \t\n "],
      ] as const)("%s 時回 500，不建立付款要求或進入 core", async (_label, value) => {
        const fetcher = facilitatorFetch();
        vi.stubGlobal("fetch", fetcher);
        const core = coreBinding(async () => Response.json({ ok: true }));
        const required = await requiredPayment(core);
        const signature = paymentHeader(required);
        fetcher.mockClear();
        const missingEnvironment = environment(core, { [key]: value });

        const responses = [
          await app.request("/api/fact-check?text=設定缺漏", {}, missingEnvironment),
          await app.request(
            "/api/fact-check",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "PAYMENT-SIGNATURE": signature,
              },
              body: JSON.stringify({ text: "設定缺漏" }),
            },
            missingEnvironment,
          ),
        ];

        for (const response of responses) {
          expect(response.status).toBe(500);
          expect(response.headers.has("PAYMENT-REQUIRED")).toBe(false);
          expect(response.headers.has("PAYMENT-RESPONSE")).toBe(false);
          expect(await response.json()).toMatchObject({ status: "error", error: "INTERNAL_ERROR" });
        }
        expect(fetcher).not.toHaveBeenCalled();
        expect(core.fetch).not.toHaveBeenCalled();
      });
    },
  );

  it("付款說明會使用實際設定的價格", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const response = await api.request(
      "/fact-check?text=%E6%B8%AC%E8%A9%A6",
      {},
      environment(core, { X402_PRICE: "$0.12" }),
    );

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
    expect(required.accepts[0]).toMatchObject({ amount: "120000" });
    expect(required.resource.description).toContain("每次呼叫收取 $0.12 USDC");
  });

  it("CDP facilitator 會為 supported、verify 與 settle 產生綁定路徑的短效 JWT", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const cdpEnvironment = environment(core, {
      FACILITATOR_URL: cdpFacilitatorUrl,
      CDP_API_KEY_ID: cdpApiKeyId,
      CDP_API_KEY_SECRET: cdpApiKeySecret,
    });
    const requiredResponse = await api.request("/fact-check?text=CDP", {}, cdpEnvironment);
    const required = decodePaymentRequiredHeader(requiredResponse.headers.get("PAYMENT-REQUIRED")!);
    const paidResponse = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": paymentHeader(required),
        },
        body: JSON.stringify({ text: "CDP JWT" }),
      },
      cdpEnvironment,
    );

    expect(requiredResponse.status).toBe(402);
    expect(paidResponse.status).toBe(200);
    const facilitatorRequests = fetcher.mock.calls.map(
      ([input, init]) =>
        new Request(input as string | URL | Request, init as RequestInit | undefined),
    );
    const expectedUris = new Map([
      ["/platform/v2/x402/supported", "GET api.cdp.coinbase.com/platform/v2/x402/supported"],
      ["/platform/v2/x402/verify", "POST api.cdp.coinbase.com/platform/v2/x402/verify"],
      ["/platform/v2/x402/settle", "POST api.cdp.coinbase.com/platform/v2/x402/settle"],
    ]);

    for (const [path, expectedUri] of expectedUris) {
      const request = facilitatorRequests.find(
        (candidate) => new URL(candidate.url).pathname === path,
      );
      expect(request).toBeDefined();
      const claims = jwtClaims(request!);
      expect(claims.sub).toBe(cdpApiKeyId);
      expect(claims.uris).toEqual([expectedUri]);
      expect(claims.exp - claims.iat).toBe(120);
    }
  });

  it("固定 facilitator token 只以 Bearer header 傳給 generic facilitator", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ ok: true }));
    const tokenEnvironment = environment(core, { FACILITATOR_AUTH_TOKEN: "test-token" });
    const requiredResponse = await api.request("/fact-check?text=token", {}, tokenEnvironment);
    const required = decodePaymentRequiredHeader(requiredResponse.headers.get("PAYMENT-REQUIRED")!);
    const paidResponse = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": paymentHeader(required),
        },
        body: JSON.stringify({ text: "Bearer token" }),
      },
      tokenEnvironment,
    );

    expect(paidResponse.status).toBe(200);
    for (const [input, init] of fetcher.mock.calls) {
      const request = new Request(input as string | URL | Request, init as RequestInit | undefined);
      expect(request.headers.get("Authorization")).toBe("Bearer test-token");
      expect(request.headers.has("x-api-key-id")).toBe(false);
      expect(request.headers.has("x-api-key-secret")).toBe(false);
    }
  });

  it("CDP credentials 未設定、缺一或混用固定 token 時會拒絕啟動付款 middleware", async () => {
    const core = coreBinding(async () => Response.json({ ok: true }));

    await expect(
      api.request(
        "/fact-check?text=missing",
        {},
        environment(core, { FACILITATOR_URL: cdpFacilitatorUrl }),
      ),
    ).resolves.toMatchObject({ status: 500 });
    await expect(
      api.request(
        "/fact-check?text=partial",
        {},
        environment(core, { CDP_API_KEY_ID: cdpApiKeyId }),
      ),
    ).resolves.toMatchObject({ status: 500 });
    await expect(
      api.request(
        "/fact-check?text=mixed",
        {},
        environment(core, {
          CDP_API_KEY_ID: cdpApiKeyId,
          CDP_API_KEY_SECRET: cdpApiKeySecret,
          FACILITATOR_AUTH_TOKEN: "test-token",
        }),
      ),
    ).resolves.toMatchObject({ status: 500 });
  });

  it("未付款 HEAD 回 405，不呼叫 facilitator 或 core", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ status: "completed" }));
    const response = await app.request(
      "/api/fact-check?text=%E6%B8%AC%E8%A9%A6",
      { method: "HEAD" },
      environment(core),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST, OPTIONS");
    expect(fetcher).not.toHaveBeenCalled();
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
    const sharedEnvironment = environment(core);

    const postResponse = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": header },
        body: JSON.stringify({ text: "POST 主張", url: "https://example.com/a" }),
      },
      sharedEnvironment,
    );
    expect(postResponse.status).toBe(200);

    const getResponse = await api.request(
      "/fact-check?text=GET%20%E4%B8%BB%E5%BC%B5&url=https%3A%2F%2Fexample.com%2Fb",
      {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader(
            required,
            "0xsignature-get",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
          ),
        },
      },
      sharedEnvironment,
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

  it("X-PAYMENT 的 x402 v2 payload 會依序完成 verify、core 與 settle", async () => {
    const events: string[] = [];
    const fetcher = facilitatorFetch({
      onRequest(path) {
        if (path.endsWith("/verify")) events.push("verify");
        if (path.endsWith("/settle")) events.push("settle");
      },
    });
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async (request) => {
      events.push("core");
      expect(await request.json()).toEqual({ text: "X-PAYMENT v2 主張" });
      return Response.json({ status: "completed" });
    });
    const required = await requiredPayment(core);
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT": paymentHeader(required),
        },
        body: JSON.stringify({ text: "X-PAYMENT v2 主張" }),
      },
      environment(core),
    );

    expect(response.status).toBe(200);
    expect(events).toEqual(["verify", "core", "settle"]);
    expect(response.headers.has("PAYMENT-RESPONSE")).toBe(true);
  });

  it("無效的 PAYMENT-SIGNATURE 優先於有效的 X-PAYMENT", async () => {
    const invalidSignature = "0xinvalid-canonical";
    const validAlternative = "0xvalid-alternative";
    const events: string[] = [];
    const fetcher = facilitatorFetch({
      invalidSignature,
      onRequest(path) {
        if (path.endsWith("/verify")) events.push("verify");
        if (path.endsWith("/settle")) events.push("settle");
      },
    });
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => {
      events.push("core");
      return Response.json({ status: "completed" });
    });
    const required = await requiredPayment(core);
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": paymentHeader(required, invalidSignature),
          "X-PAYMENT": paymentHeader(required, validAlternative),
        },
        body: JSON.stringify({ text: "canonical 優先" }),
      },
      environment(core),
    );
    const verifyCall = fetcher.mock.calls.find(([input]) => String(input).endsWith("/verify"));
    const verifyRequest = new Request(
      verifyCall![0] as string | URL | Request,
      verifyCall![1] as RequestInit | undefined,
    );
    const verifyBody = (await verifyRequest.json()) as {
      paymentPayload: { payload: { signature: string } };
    };

    expect(response.status).toBe(402);
    expect(verifyBody.paymentPayload.payload.signature).toBe(invalidSignature);
    expect(verifyBody.paymentPayload.payload.signature).not.toBe(validAlternative);
    expect(events).toEqual(["verify"]);
    expect(core.fetch).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/settle"))).toHaveLength(
      0,
    );
  });

  it("拒絕 X-PAYMENT 中的 x402 v1 payload，不進入 core 或 settle", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => Response.json({ status: "completed" }));
    const required = await requiredPayment(core);
    const payment = JSON.parse(Buffer.from(paymentHeader(required), "base64").toString("utf8"));
    const legacyPayload = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: "base",
        payload: payment.payload,
      }),
    ).toString("base64");
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT": legacyPayload,
        },
        body: JSON.stringify({ text: "v1 不應付款" }),
      },
      environment(core),
    );

    expect(response.status).toBe(402);
    expect(core.fetch).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/verify"))).toHaveLength(
      0,
    );
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/settle"))).toHaveLength(
      0,
    );
  });

  it("核心不可變的 502 回應保留狀態、本文與標頭，且不結算", async () => {
    const errorBody = { status: "error", error: "UPSTREAM_UNAVAILABLE", message: "核心暫時失敗。" };
    const server = createServer((_request, response) => {
      response.writeHead(502, {
        "Content-Type": "application/json",
        "Retry-After": "7",
        "X-Core-Trace": "core-502",
      });
      response.end(JSON.stringify(errorBody));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("本機測試服務未啟動。");
      const upstream = await fetch(`http://127.0.0.1:${address.port}/fact-check`);
      expect(() => upstream.headers.delete("X-Test")).toThrow(TypeError);
      const fetcher = facilitatorFetch();
      vi.stubGlobal("fetch", fetcher);
      const core = coreBinding(async () => upstream);
      const required = await requiredPayment(core);
      const response = await api.request(
        "/fact-check",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentHeader(required),
          },
          body: JSON.stringify({ text: "核心錯誤" }),
        },
        environment(core),
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(errorBody);
      expect(response.headers.get("Retry-After")).toBe("7");
      expect(response.headers.get("X-Core-Trace")).toBe("core-502");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(
        fetcher.mock.calls.filter(([request]) => String(request).endsWith("/verify")),
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(([request]) => String(request).endsWith("/settle")),
      ).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    }
  });

  it("核心 fetch 拋例外轉成 502 時不結算", async () => {
    const fetcher = facilitatorFetch();
    vi.stubGlobal("fetch", fetcher);
    const core = coreBinding(async () => {
      throw new Error("core network failure");
    });
    const required = await requiredPayment(core);
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": paymentHeader(required),
        },
        body: JSON.stringify({ text: "核心網路錯誤" }),
      },
      environment(core),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: "UPSTREAM_UNAVAILABLE",
    });
    expect(
      fetcher.mock.calls.filter(([request]) => String(request).endsWith("/verify")),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([request]) => String(request).endsWith("/settle")),
    ).toHaveLength(0);
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
