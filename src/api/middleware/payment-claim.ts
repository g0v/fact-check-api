import { Buffer } from "node:buffer";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import type { ApiBindings } from "../types/fact-check";
import { ApiError } from "../utils/errors";

export type ClaimedPayment = {
  releaseReservation(): Promise<void>;
};

// 僅在 SDK 驗證付款成功後呼叫；簽章、JSON 排序、資源描述與標頭別名不影響 authorization 身分。
export async function claimVerifiedPayment(
  env: ApiBindings,
  header: string | undefined,
  reverify: (payment: PaymentPayload) => Promise<boolean>,
): Promise<ClaimedPayment> {
  const namespace = env.PAYMENT_CLAIM_DO;
  if (!namespace) throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "付款防重放服務未設定。", 500);

  let key: string;
  let accountKey: string;
  let amount: string;
  let expiresAt: number;
  let payment: PaymentPayload;
  try {
    if (!header) throw new Error("缺少付款授權。");
    payment = decodePaymentSignatureHeader(header);
    // SDK 以欄位是否存在選擇 Permit2；不得用未經該驗證路徑驗證的 authorization 建立 claim。
    if (
      typeof payment.payload !== "object" ||
      payment.payload === null ||
      !("authorization" in payment.payload) ||
      "permit2Authorization" in payment.payload
    ) {
      throw new Error("付款防重放檢查僅支援 EIP-3009 授權。");
    }
    const authorization = payment.payload.authorization as
      | { from?: unknown; nonce?: unknown; validBefore?: unknown; value?: unknown }
      | undefined;
    if (
      payment.x402Version !== 2 ||
      payment.accepted.scheme !== "exact" ||
      !/^eip155:\d+$/.test(payment.accepted.network) ||
      !/^0x[\da-f]{40}$/i.test(payment.accepted.asset) ||
      typeof authorization?.from !== "string" ||
      !/^0x[\da-f]{40}$/i.test(authorization.from) ||
      typeof authorization.nonce !== "string" ||
      !/^0x[\da-f]{64}$/i.test(authorization.nonce) ||
      typeof authorization.validBefore !== "string" ||
      typeof authorization.value !== "string" ||
      !/^[1-9]\d{0,77}$/.test(authorization.value) ||
      BigInt(authorization.value) > 2n ** 256n - 1n ||
      authorization.value !== payment.accepted.amount
    ) {
      throw new Error("付款授權格式不正確。");
    }
    const validBeforeMs = Number(BigInt(authorization.validBefore) * 1000n);
    // 清理 TTL 必須涵蓋完整授權效期；不可用短租約重新開放仍在執行的 core。
    expiresAt = validBeforeMs + 60_000;
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt > 8_640_000_000_000_000 ||
      validBeforeMs <= Date.now()
    ) {
      throw new Error("付款授權已過期或效期無法處理。");
    }
    const identity = `eip3009:eip155:${BigInt(payment.accepted.network.slice(7))}:${payment.accepted.asset.toLowerCase()}:${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`;
    const accountIdentity = `eip3009:account:eip155:${BigInt(payment.accepted.network.slice(7))}:${payment.accepted.asset.toLowerCase()}:${authorization.from.toLowerCase()}`;
    key = await paymentKey(identity);
    accountKey = await paymentKey(accountIdentity);
    amount = authorization.value;
  } catch {
    throw new ApiError("INVALID_PAYMENT", "付款授權無法用於防重放檢查，請提供新的有效付款。", 400);
  }

  const reservationId = crypto.randomUUID();
  let accountStub: ReturnType<typeof namespace.get>;
  let reserved: boolean;
  let authorizationAlreadyClaimed: boolean;
  try {
    accountStub = namespace.get(namespace.idFromName(accountKey));
    const response = await accountStub.fetch("https://payment-claim/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorizationKey: key, reservationId, amount, expiresAt }),
    });
    if (!response.ok) throw new Error("付款進行中占位失敗。");
    const result = (await response.json()) as {
      reserved?: unknown;
      authorizationAlreadyClaimed?: unknown;
    } | null;
    if (
      !result ||
      typeof result.reserved !== "boolean" ||
      typeof result.authorizationAlreadyClaimed !== "boolean"
    ) {
      throw new Error("付款進行中占位回應格式不正確。");
    }
    reserved = result.reserved;
    authorizationAlreadyClaimed = result.authorizationAlreadyClaimed;
  } catch {
    throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "付款防重放服務暫時無法使用。", 500);
  }
  if (!reserved) {
    if (authorizationAlreadyClaimed) throw alreadyClaimed();
    throw new ApiError(
      "PAYMENT_IN_PROGRESS",
      "此付款地址仍有進行中或結果未確認的付款，請待付款完成或授權到期後重試。",
      409,
    );
  }

  const releaseReservation = async () => {
    const response = await accountStub.fetch("https://payment-claim/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId }),
    });
    if (!response.ok) throw new Error("付款進行中占位釋放失敗。");
    const result = (await response.json()) as { released?: unknown } | null;
    if (!result || result.released !== true) throw new Error("付款進行中占位未能釋放。");
  };

  try {
    let claimed: boolean;
    try {
      const stub = namespace.get(namespace.idFromName(key));
      const response = await stub.fetch("https://payment-claim/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresAt }),
      });
      if (!response.ok) throw new Error("付款 claim 失敗。");
      const result = (await response.json()) as { claimed?: unknown } | null;
      if (!result || typeof result.claimed !== "boolean")
        throw new Error("付款 claim 回應格式不正確。");
      claimed = result.claimed;
    } catch {
      // 保留原有 nonce 物件與 key，部署更新後仍能辨識先前已建立的 claim。
      throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "付款防重放服務暫時無法使用。", 500);
    }
    if (!claimed) throw alreadyClaimed();

    // 在地址占位內重新查驗，避免另一筆結算後仍使用先前的餘額驗證結果。
    let isValid: boolean;
    try {
      isValid = await reverify(payment);
    } catch {
      throw new ApiError("PAYMENT_VERIFICATION_UNAVAILABLE", "付款重新驗證暫時無法使用。", 502);
    }
    if (!isValid) {
      throw new ApiError("INVALID_PAYMENT", "付款重新驗證失敗，請提供新的有效付款。", 400);
    }
    if (expiresAt - 60_000 <= Date.now()) {
      throw new ApiError("INVALID_PAYMENT", "付款授權已過期，請提供新的有效付款。", 400);
    }
    return { releaseReservation };
  } catch (error) {
    // 尚未進入 core 或 settle，可釋放地址占位；nonce claim 仍保留，釋放失敗則保留占位直到到期。
    try {
      await releaseReservation();
    } catch {
      // 不確認占位已釋放，後續請求仍由持久物件拒絕。
    }
    throw error;
  }
}

async function paymentKey(identity: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  ).toString("hex");
}

function alreadyClaimed(): ApiError {
  return new ApiError(
    "PAYMENT_ALREADY_CLAIMED",
    "此付款授權已用於查核請求，請以新的付款授權重試。",
    409,
  );
}
