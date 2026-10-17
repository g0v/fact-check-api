import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Challenge, Credential, Receipt } from "mppx";
import { api } from "../src/api";
import type { ApiBindings, ServiceBindingLike } from "../src/api/types/fact-check";
import { paymentClaimNamespace } from "./fixtures/payment-claim";
import { mppStoreNamespace } from "./fixtures/mpp-store";

const payTo = "0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB";
const depositAddress = "0x00000000000000000000000000000000000000d1";
const payer = "0x00000000000000000000000000000000000000a1";
const otherPayer = "0x00000000000000000000000000000000000000a2";
const path = "/fact-check?text=%E6%B8%AC%E8%A9%A6%E4%B8%BB%E5%BC%B5";

// 以假的 Tempo 收款方式取代 Stripe／Tempo 網路呼叫；challenge 簽發、HMAC 綁定與 Store 仍使用真實 mppx。
const fake = vi.hoisted(() => ({
  createParameters: [] as Array<Record<string, unknown>>,
  depositLookups: 0,
  depositFailure: false,
  validations: 0,
  broadcasts: [] as string[],
  broadcastFailure: false,
  onBroadcast: undefined as undefined | (() => void),
}));

vi.mock("mppx/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mppx/server")>();
  const { Method: MethodModule, Receipt: ReceiptModule } = await import("mppx");
  const { Methods } = await import("mppx/tempo");
  const create = (parameters: Record<string, unknown>) => {
    fake.createParameters.push(parameters);
    const store = parameters.store as import("mppx/server").Store.AtomicStore;
    const signatureOf = (credential: { payload: unknown }) => {
      const payload = credential.payload as { type: string; signature?: string };
      // 測試簽章格式：0x + 付款地址 40 位 hex + 4 位 nonce。
      if (payload.type !== "transaction" || payload.signature?.length !== 46) {
        throw new Error("交易簽章無效。");
      }
      return payload.signature;
    };
    return {
      async findOrCreateDepositAddress() {
        fake.depositLookups++;
        if (fake.depositFailure) throw new Error("Stripe 暫時無法使用。");
        return depositAddress;
      },
      tempo: {
        charge({ recipient }: { recipient: string }) {
          return MethodModule.toServer(Methods.charge, {
            defaults: {
              currency: "0x20c0000000000000000000000000000000000000",
              decimals: 6,
              recipient,
            },
            async validate({ credential, request }) {
              fake.validations++;
              const signature = signatureOf(credential);
              return {
                challenge: credential.challenge,
                credential,
                details: { mode: "pull" },
                intent: "charge",
                method: "tempo",
                payer: `0x${signature.slice(2, 42)}`,
                request,
              } as never;
            },
            async broadcast({ credential }) {
              const signature = signatureOf(credential);
              fake.onBroadcast?.();
              if (fake.broadcastFailure) throw new Error("廣播失敗。");
              // 與真實 Tempo charge 相同：以共用 Store 擋下同一筆交易重複廣播。
              if (!(await actual.Store.tryClaim(store, `hash:${signature}`, Date.now() + 60_000))) {
                throw new Error("交易已使用。");
              }
              fake.broadcasts.push(signature);
              return ReceiptModule.from({
                method: "tempo",
                status: "success",
                reference: `0xtx-${fake.broadcasts.length}`,
                timestamp: new Date().toISOString(),
              });
            },
          });
        },
      },
    };
  };
  return { ...actual, stripe: Object.assign(() => undefined, actual.stripe, { create }) };
});

beforeEach(() => {
  fake.createParameters = [];
  fake.depositLookups = 0;
  fake.depositFailure = false;
  fake.validations = 0;
  fake.broadcasts = [];
  fake.broadcastFailure = false;
  fake.onBroadcast = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function coreBinding(
  handler: (request: Request) => Promise<Response> = async () =>
    Response.json({ status: "ok", verdict: "測試結果" }),
): ServiceBindingLike {
  return { fetch: vi.fn(handler) };
}

function environment(core: ServiceBindingLike, extra: Partial<ApiBindings> = {}): ApiBindings {
  return {
    FACT_CHECK_CORE: core,
    PAYMENT_CLAIM_DO: paymentClaimNamespace(),
    MPP_STORE_DO: mppStoreNamespace(),
    PAY_TO: payTo,
    X402_NETWORK: "eip155:8453",
    X402_PRICE: "$0.05",
    FACILITATOR_URL: "https://facilitator.example.test",
    MPP_SECRET_KEY: "test-mpp-secret-key-at-least-32-bytes-long",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    MPP_TEMPO_DEPOSIT_ADDRESS: depositAddress,
    ...extra,
  };
}

// x402 SDK 在產生 402 前會向 facilitator 查詢 supported；本測試只需要這個端點。
function stubFacilitator() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/supported")) {
        return Response.json({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
          extensions: [],
        });
      }
      return new Response("非預期的外部請求。", { status: 500 });
    }),
  );
}

async function challengeFor(env: ApiBindings) {
  const response = await api.request(path, {}, env);
  expect(response.status).toBe(402);
  return Challenge.fromResponse(response);
}

function credentialFor(challenge: Challenge.Challenge, from = payer, nonce = "1") {
  return Credential.serialize(
    Credential.from({
      challenge,
      payload: { type: "transaction", signature: `${from}${nonce.padStart(4, "0")}` },
    }),
  );
}

describe("MPP 付款（Stripe Machine Payments）", () => {
  it("未設定 MPP secrets 時維持只有 x402 的 402", async () => {
    stubFacilitator();
    const env = environment(coreBinding(), {
      MPP_SECRET_KEY: undefined,
      STRIPE_SECRET_KEY: undefined,
    });
    const response = await api.request(path, {}, env);
    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(fake.createParameters).toHaveLength(0);
  });

  it("只設定其中一把 MPP secret 視為設定錯誤", async () => {
    stubFacilitator();
    const env = environment(coreBinding(), { STRIPE_SECRET_KEY: undefined });
    const response = await api.request(path, {}, env);
    expect(response.status).toBe(500);
  });

  it("未付款的 402 同時提供 x402 與 MPP challenge", async () => {
    stubFacilitator();
    const env = environment(coreBinding());
    const response = await api.request(path, {}, env);
    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const challenge = Challenge.fromResponse(response);
    expect(challenge.method).toBe("tempo");
    expect(challenge.intent).toBe("charge");
    expect(challenge.request).toMatchObject({
      amount: "50000",
      recipient: depositAddress,
      methodDetails: { supportedModes: ["pull"] },
    });
    const ttl = Date.parse(challenge.expires!) - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    expect(fake.createParameters[0]).toMatchObject({ livemode: false });
    expect(fake.depositLookups).toBe(0);
  });

  it("未設定存款地址時向 Stripe 查詢一次並快取", async () => {
    stubFacilitator();
    const env = environment(coreBinding(), { MPP_TEMPO_DEPOSIT_ADDRESS: undefined });
    await challengeFor(env);
    await challengeFor(env);
    expect(fake.depositLookups).toBe(1);
  });

  it("Stripe 暫時無法使用時仍回 x402 的 402，之後重試", async () => {
    stubFacilitator();
    const env = environment(coreBinding(), { MPP_TEMPO_DEPOSIT_ADDRESS: undefined });
    fake.depositFailure = true;
    const degraded = await api.request(path, {}, env);
    expect(degraded.status).toBe(402);
    expect(degraded.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(degraded.headers.get("WWW-Authenticate")).toBeNull();
    fake.depositFailure = false;
    await challengeFor(env);
    expect(fake.depositLookups).toBe(2);
  });

  it("正式金鑰使用 livemode", async () => {
    stubFacilitator();
    await challengeFor(environment(coreBinding(), { STRIPE_SECRET_KEY: "sk_live_placeholder" }));
    expect(fake.createParameters[0]).toMatchObject({ livemode: true });
  });

  it("付款成功：core 完成後才廣播並附上 Payment-Receipt", async () => {
    stubFacilitator();
    const order: string[] = [];
    const core = coreBinding(async () => {
      order.push("core");
      return Response.json({ status: "ok" });
    });
    fake.onBroadcast = () => order.push("broadcast");
    const env = environment(core);
    const challenge = await challengeFor(env);
    const response = await api.request(
      path,
      { headers: { Authorization: credentialFor(challenge) } },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(order).toEqual(["core", "broadcast"]);
    const receipt = Receipt.deserialize(response.headers.get("Payment-Receipt")!);
    expect(receipt).toMatchObject({ method: "tempo", status: "success", reference: "0xtx-1" });
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Payment-Receipt");
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });

  it("POST 請求同樣可用 MPP 付款", async () => {
    stubFacilitator();
    const core = coreBinding();
    const env = environment(core);
    const challenge = await challengeFor(env);
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: credentialFor(challenge) },
        body: JSON.stringify({ text: "測試主張" }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(core.fetch).toHaveBeenCalledTimes(1);
  });

  it("同一憑證重送會被拒絕，core 只執行一次", async () => {
    stubFacilitator();
    const core = coreBinding();
    const env = environment(core);
    const credential = credentialFor(await challengeFor(env));
    const first = await api.request(path, { headers: { Authorization: credential } }, env);
    expect(first.status).toBe(200);
    const replay = await api.request(path, { headers: { Authorization: credential } }, env);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "PAYMENT_ALREADY_CLAIMED" });
    expect(core.fetch).toHaveBeenCalledTimes(1);
    expect(fake.broadcasts).toHaveLength(1);
  });

  it("同一筆已簽交易搭配新 challenge 重送時，共用 Store 拒絕廣播且不交付結果", async () => {
    stubFacilitator();
    const env = environment(coreBinding());
    const first = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env)) } },
      env,
    );
    expect(first.status).toBe(200);
    const reused = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env)) } },
      env,
    );
    expect(reused.status).toBe(402);
    expect(await reused.json()).toMatchObject({ error: "PAYMENT_FAILED" });
    expect(reused.headers.get("Payment-Receipt")).toBeNull();
    expect(fake.broadcasts).toHaveLength(1);
  });

  it("core 失敗時不廣播、不收費，並立即釋放付款地址", async () => {
    stubFacilitator();
    let fail = true;
    const core = coreBinding(async () =>
      fail ? Response.json({ status: "error" }, { status: 502 }) : Response.json({ status: "ok" }),
    );
    const env = environment(core);
    const failed = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env)) } },
      env,
    );
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Payment-Receipt")).toBeNull();
    expect(fake.broadcasts).toHaveLength(0);

    fail = false;
    const retried = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env), payer, "2") } },
      env,
    );
    expect(retried.status).toBe(200);
    expect(fake.broadcasts).toHaveLength(1);
  });

  it("輸入驗證失敗不收費", async () => {
    stubFacilitator();
    const core = coreBinding();
    const env = environment(core);
    const challenge = await challengeFor(env);
    const response = await api.request(
      "/fact-check?text=",
      { headers: { Authorization: credentialFor(challenge) } },
      env,
    );
    expect(response.status).toBe(400);
    expect(core.fetch).not.toHaveBeenCalled();
    expect(fake.broadcasts).toHaveLength(0);
  });

  it("廣播失敗時回 402、不交付結果，並保留付款地址占位", async () => {
    stubFacilitator();
    const env = environment(coreBinding());
    fake.broadcastFailure = true;
    const response = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env)) } },
      env,
    );
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toMatchObject({ error: "PAYMENT_FAILED" });
    expect(body).not.toHaveProperty("verdict");
    expect(response.headers.get("Payment-Receipt")).toBeNull();
    expect(Challenge.fromResponse(response).method).toBe("tempo");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    fake.broadcastFailure = false;
    const next = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env), payer, "2") } },
      env,
    );
    expect(next.status).toBe(409);
    expect(await next.json()).toMatchObject({ error: "PAYMENT_IN_PROGRESS" });

    const other = await api.request(
      path,
      { headers: { Authorization: credentialFor(await challengeFor(env), otherPayer) } },
      env,
    );
    expect(other.status).toBe(200);
  });

  it("同一付款地址同時只能有一筆付款進行中", async () => {
    stubFacilitator();
    let releaseCore!: () => void;
    const gate = new Promise<void>((resolve) => (releaseCore = resolve));
    const core = coreBinding(async () => {
      await gate;
      return Response.json({ status: "ok" });
    });
    const env = environment(core);
    const firstChallenge = await challengeFor(env);
    const secondChallenge = await challengeFor(env);
    const first = api.request(
      path,
      { headers: { Authorization: credentialFor(firstChallenge) } },
      env,
    );
    await vi.waitFor(() => expect(core.fetch).toHaveBeenCalledTimes(1));
    const second = await api.request(
      path,
      { headers: { Authorization: credentialFor(secondChallenge, payer, "2") } },
      env,
    );
    expect(second.status).toBe(409);
    releaseCore();
    expect((await first).status).toBe(200);
  });

  it("竄改 challenge 內容的憑證會被拒絕且不執行 core", async () => {
    stubFacilitator();
    const core = coreBinding();
    const env = environment(core);
    const challenge = await challengeFor(env);
    const tampered = { ...challenge, request: { ...challenge.request, amount: "1" } };
    const response = await api.request(
      path,
      { headers: { Authorization: credentialFor(tampered as Challenge.Challenge) } },
      env,
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: "INVALID_PAYMENT" });
    expect(Challenge.fromResponse(response).method).toBe("tempo");
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("其他伺服器金鑰簽發的 challenge 無法使用", async () => {
    stubFacilitator();
    const core = coreBinding();
    const otherEnv = environment(coreBinding(), {
      MPP_SECRET_KEY: "another-mpp-secret-key-at-least-32-bytes",
    });
    const foreign = await challengeFor(otherEnv);
    const env = environment(core);
    const response = await api.request(
      path,
      { headers: { Authorization: credentialFor(foreign) } },
      env,
    );
    expect(response.status).toBe(402);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("無效的交易簽章不執行 core", async () => {
    stubFacilitator();
    const core = coreBinding();
    const env = environment(core);
    const challenge = await challengeFor(env);
    const credential = Credential.serialize(
      Credential.from({ challenge, payload: { type: "transaction", signature: "0xbad" } }),
    );
    const response = await api.request(path, { headers: { Authorization: credential } }, env);
    expect(response.status).toBe(402);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("同時帶 x402 與 MPP 付款標頭時拒絕", async () => {
    stubFacilitator();
    const core = coreBinding();
    const env = environment(core);
    const challenge = await challengeFor(env);
    const response = await api.request(
      path,
      { headers: { Authorization: credentialFor(challenge), "PAYMENT-SIGNATURE": "x" } },
      env,
    );
    expect(response.status).toBe(400);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("CORS 預檢允許 Authorization 並公開 MPP 標頭", async () => {
    const response = await api.request(
      "/fact-check",
      {
        method: "OPTIONS",
        headers: { Origin: "https://example.org", "Access-Control-Request-Method": "GET" },
      },
      environment(coreBinding()),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
  });
});

describe("MppStoreDO", () => {
  it("提供 mppx 需要的原子讀寫與重放標記", async () => {
    const namespace = mppStoreNamespace();
    const call = async (key: string, route: string, body: unknown) =>
      (
        await namespace.get(namespace.idFromName(key)).fetch(`https://mpp-store${route}`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).json() as Promise<Record<string, unknown>>;
    expect(await call("k", "/get", {})).toEqual({ value: null, version: 0 });
    expect(await call("k", "/cas", { version: 0, op: "set", value: '"a"' })).toEqual({ ok: true });
    expect(await call("k", "/cas", { version: 0, op: "set", value: '"b"' })).toEqual({ ok: false });
    expect(await call("k", "/get", {})).toEqual({ value: '"a"', version: 1 });
    expect(await call("k", "/cas", { version: 1, op: "delete" })).toEqual({ ok: true });

    const expires = Date.now() + 60_000;
    expect(await call("r", "/claim", { expires })).toEqual({ claimed: true });
    expect(await call("r", "/claim", { expires })).toEqual({ claimed: false });
    const stored = await call("r", "/get", {});
    expect(JSON.parse(stored.value as string)).toEqual({ expires, type: "mppx:replay" });
  });

  it("拒絕過期或過長的重放標記，並在到期後清除", async () => {
    const namespace = mppStoreNamespace();
    const stub = namespace.get(namespace.idFromName("r"));
    const claim = (expires: number) =>
      stub.fetch("https://mpp-store/claim", { method: "POST", body: JSON.stringify({ expires }) });
    expect((await claim(Date.now() - 1)).status).toBe(400);
    expect((await claim(Date.now() + 2 * 86_400_000)).status).toBe(400);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const expires = Date.now() + 1_000;
      expect(await (await claim(expires)).json()).toEqual({ claimed: true });
      vi.setSystemTime(expires + 1);
      await namespace.runAlarm("r");
      const after = await stub.fetch("https://mpp-store/get", { method: "POST", body: "{}" });
      expect(await after.json()).toEqual({ value: null, version: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
