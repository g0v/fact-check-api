import { Credential, Receipt } from "mppx";
import { Mppx, Store, stripe } from "mppx/server";
import Stripe from "stripe";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiBindings, ApiEnv, DurableObjectNamespaceLike } from "../types/fact-check";
import { claimPayment } from "./payment-claim";
import { ApiError } from "../utils/errors";

// MPP challenge 只用於本付費查核路由；scope 綁進 HMAC，其他路由簽發的 challenge 不能拿來付款。
const MPP_SCOPE = "fact-check";
// 與 x402 maxTimeoutSeconds 相同：challenge 簽發後 5 分鐘內須完成付款。
const CHALLENGE_TTL_MS = 300_000;
// 版本比對寫入的最大重試次數；同一 key 的寫入僅來自同一筆付款，衝突極少。
const STORE_UPDATE_ATTEMPTS = 8;

function configuredValue(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

// 兩把 secret 都未設定時停用 MPP，只提供 x402；只設定其中一把視為部署設定錯誤。
export function isMppEnabled(env: ApiBindings): boolean {
  const hasSecretKey = configuredValue(env.MPP_SECRET_KEY).length > 0;
  const hasStripeKey = configuredValue(env.STRIPE_SECRET_KEY).length > 0;
  if (hasSecretKey !== hasStripeKey) {
    throw new Error("MPP_SECRET_KEY 與 STRIPE_SECRET_KEY 必須同時設定。");
  }
  return hasSecretKey;
}

// X402_PRICE（如 "$0.05"）同時是 MPP 價格；MPP 以美元計價的穩定幣金額表示。
function mppAmount(price: string | undefined): string {
  const match = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(configuredValue(price));
  if (!match || Number(match[1]) <= 0)
    throw new Error("X402_PRICE 必須是正的美元金額，例如 $0.05。");
  return match[1];
}

type StoreRecord = { value: string | null; version: number };

// mppx 需要跨 isolate 共用的原子 Store 保存 Tempo 交易重放標記；以 MppStoreDO 實作。
function durableStore(namespace: DurableObjectNamespaceLike): Store.AtomicStore {
  const call = async (key: string, path: string, body: unknown): Promise<unknown> => {
    const stub = namespace.get(namespace.idFromName(key));
    const response = await stub.fetch(`https://mpp-store${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("MPP 儲存服務暫時無法使用。");
    return response.json();
  };
  const read = async (key: string): Promise<StoreRecord> => {
    const record = (await call(key, "/get", {})) as StoreRecord | null;
    if (!record || typeof record.version !== "number") throw new Error("MPP 儲存回應格式不正確。");
    return record;
  };
  const update = async <result>(
    key: string,
    fn: (current: string | null) => Store.Change<string, result>,
  ): Promise<result> => {
    for (let attempt = 0; attempt < STORE_UPDATE_ATTEMPTS; attempt++) {
      const { value, version } = await read(key);
      const change = fn(value);
      if (change.op === "noop") return change.result;
      const written = (await call(key, "/cas", {
        version,
        op: change.op,
        ...(change.op === "set" ? { value: change.value } : {}),
      })) as { ok?: unknown } | null;
      if (written?.ok === true) return change.result;
    }
    throw new Error("MPP 儲存寫入衝突過多。");
  };
  const store = Store.cloudflare({
    get: async (key) => (await read(key)).value,
    put: (key, value) => update(key, () => ({ op: "set", value, result: undefined })),
    delete: (key) => update(key, () => ({ op: "delete", result: undefined })),
    update,
  });
  return Object.assign(store, {
    async tryClaim(key: string, expires: number) {
      const result = (await call(key, "/claim", { expires })) as { claimed?: unknown } | null;
      if (typeof result?.claimed !== "boolean") throw new Error("MPP 儲存回應格式不正確。");
      return result.claimed;
    },
  });
}

async function createConfiguration(env: ApiBindings) {
  const stripeSecretKey = configuredValue(env.STRIPE_SECRET_KEY);
  const amount = mppAmount(env.X402_PRICE);
  if (!env.MPP_STORE_DO) {
    throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "MPP 防重放儲存服務未設定。", 500);
  }
  const client = new Stripe(stripeSecretKey, { httpClient: Stripe.createFetchHttpClient() });
  const machinePayments = stripe.create({
    client,
    // networkId 只用於 Shared Payment Token（卡片）付款；本路由未提供該方式，見 README。
    networkId: "",
    // 測試金鑰對應 Tempo testnet 的 pathUSD，正式金鑰對應 Tempo mainnet 的 USDC。
    livemode: /^(sk|rk)_live_/.test(stripeSecretKey),
    store: durableStore(env.MPP_STORE_DO),
  });
  const recipient = (configuredValue(env.MPP_TEMPO_DEPOSIT_ADDRESS) ||
    (await machinePayments.findOrCreateDepositAddress("tempo"))) as stripe.DepositAddress<"tempo">;
  const mppx = Mppx.create({
    methods: [machinePayments.tempo.charge({ recipient })],
    secretKey: configuredValue(env.MPP_SECRET_KEY),
  });
  return { mppx, amount };
}

type MppConfiguration = Awaited<ReturnType<typeof createConfiguration>>;
const configurationCache = new WeakMap<ApiBindings, Promise<MppConfiguration>>();

function mppConfiguration(env: ApiBindings): Promise<MppConfiguration> {
  const cached = configurationCache.get(env);
  if (cached) return cached;
  const created = createConfiguration(env);
  configurationCache.set(env, created);
  // 存款地址查詢等暫時性失敗不可永久快取，下一個請求重新建立。
  created.catch(() => configurationCache.delete(env));
  return created;
}

// 只接受 pull 模式：client 簽好交易交給本服務，core 成功後才廣播，失敗的查核不收費。
// push 模式（client 先自行上鏈）無法在 core 失敗時不收費，因此不提供。
const SUPPORTED_MODES: ["pull"] = ["pull"];

function routeOptions(configuration: MppConfiguration) {
  return {
    request: { amount: configuration.amount, supportedModes: SUPPORTED_MODES },
    scope: MPP_SCOPE,
  };
}

// 回傳本請求可用的 MPP challenge（WWW-Authenticate 值）；金額低於收款方式下限時回 null。
export async function mppChallenge(c: Context<ApiEnv>): Promise<string | null> {
  const configuration = await mppConfiguration(c.env);
  // 只用來簽發 challenge：移除任何付款憑證，也不轉送本文，避免 SDK 進入驗證或結算流程。
  const headers = new Headers(c.req.raw.headers);
  headers.delete("Authorization");
  const result = await configuration.mppx.tempo.charge({
    amount: configuration.amount,
    supportedModes: SUPPORTED_MODES,
    expires: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    description: "fact-check-api 付費查核，每次呼叫一次付款。",
    scope: MPP_SCOPE,
  })(new Request(c.req.url, { method: c.req.method, headers }));
  if (result.status !== 402) return null;
  return result.challenge.headers.get("WWW-Authenticate");
}

// 付款憑證無效或結算失敗時回 402，附上新的 challenge 讓 client 重新付款；不附 Payment-Receipt。
async function paymentRequired(
  c: Context<ApiEnv>,
  code: string,
  message: string,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Request-Id": c.get("requestId"),
  });
  try {
    const challenge = await mppChallenge(c);
    if (challenge) headers.set("WWW-Authenticate", challenge);
  } catch {
    // 無法簽發新 challenge 時仍回報付款失敗；client 可重新發出未付款請求取得 challenge。
  }
  return new Response(
    JSON.stringify({ status: "error", error: code, message, request_id: c.get("requestId") }),
    { status: 402, headers },
  );
}

export function mppCredential(c: Context<ApiEnv>): string | null {
  const authorization = c.req.header("Authorization");
  return authorization ? Credential.extractPaymentScheme(authorization) : null;
}

// MPP 付款流程，對應 x402 的 verify → claim → core → settle：
// 驗證憑證（不廣播）→ 占位付款地址並 claim challenge → 執行 core → core 成功才廣播交易並附收據。
export const mppPaymentMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const credential = mppCredential(c);
  if (!credential) throw new ApiError("INVALID_PAYMENT", "缺少 MPP 付款憑證。", 400);
  const configuration = await mppConfiguration(c.env);
  const options = routeOptions(configuration);

  let validation: Awaited<ReturnType<typeof configuration.mppx.validateCredential>>;
  try {
    validation = await configuration.mppx.validateCredential(credential, options);
  } catch {
    return paymentRequired(
      c,
      "INVALID_PAYMENT",
      "MPP 付款憑證無效、已過期或不符本路由，請依新的 challenge 重新付款。",
    );
  }
  const { challenge } = validation.credential;
  const payer = validation.payer;
  // challenge 已由 HMAC 綁定且與本路由金額比對過；其 request.amount 為最小單位金額。
  const amount = (challenge.request as { amount?: unknown }).amount;
  const mode = (validation.details as { mode?: unknown } | undefined)?.mode;
  if (!payer || typeof amount !== "string" || !challenge.expires || mode !== "pull") {
    return paymentRequired(c, "INVALID_PAYMENT", "MPP 付款憑證缺少付款人或金額，請重新付款。");
  }

  const claim = await claimPayment(
    c.env,
    {
      identity: `mpp:${challenge.method}:${challenge.intent}:challenge:${challenge.id}`,
      accountIdentity: `mpp:${challenge.method}:account:${payer.toLowerCase()}`,
      amount,
      // challenge 到期後憑證即失效；多留 60 秒涵蓋廣播與確認時間。
      expiresAt: Date.parse(challenge.expires) + 60_000,
    },
    async () => {
      try {
        await configuration.mppx.validateCredential(credential, options);
        return true;
      } catch {
        return false;
      }
    },
  );

  await next();

  if (c.res.status >= 400) {
    // core 失敗：交易從未廣播、未收費，可立即釋放付款地址占位；challenge 已使用，需重新付款。
    try {
      await claim.releaseReservation();
    } catch {
      // 無法確認釋放時保留占位至到期。
    }
    return;
  }

  let receipt: Receipt.Receipt;
  try {
    receipt = await configuration.mppx.broadcastCredential(credential, options);
  } catch {
    // 廣播結果不明時不交付查核結果，也不釋放占位，直到 challenge 到期。
    void c.res.body?.cancel().catch(() => undefined);
    const failed = await paymentRequired(
      c,
      "PAYMENT_FAILED",
      "MPP 付款結算失敗，本次未交付查核結果，請以新的 challenge 重新付款。",
    );
    c.res = undefined;
    c.res = failed;
    return;
  }

  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("Payment-Receipt", Receipt.serialize(receipt));
  try {
    await claim.releaseReservation();
  } catch {
    // 已結算的回應仍交付；無法確認釋放成功時保留占位至到期。
  }
};
