import { Buffer } from "node:buffer";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { ApiBindings } from "../types/fact-check";
import { ApiError } from "../utils/errors";

// 僅在 SDK 驗證付款成功後呼叫；簽章、JSON 排序、資源描述與標頭別名不影響 authorization 身分。
export async function claimVerifiedPayment(
  env: ApiBindings,
  header: string | undefined,
): Promise<void> {
  const namespace = env.PAYMENT_CLAIM_DO;
  if (!namespace) throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "付款防重放服務未設定。", 500);

  let key: string;
  let expiresAt: number;
  try {
    if (!header) throw new Error("缺少付款授權。");
    const payment = decodePaymentSignatureHeader(header);
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
      | { from?: unknown; nonce?: unknown; validBefore?: unknown }
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
      typeof authorization.validBefore !== "string"
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
    key = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
    ).toString("hex");
  } catch {
    throw new ApiError("INVALID_PAYMENT", "付款授權無法用於防重放檢查，請提供新的有效付款。", 400);
  }

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
    // 不能確認原子 claim 成功時一律拒絕；不得降級成 isolate 內的鎖或直接放行。
    throw new ApiError("PAYMENT_CLAIM_UNAVAILABLE", "付款防重放服務暫時無法使用。", 500);
  }
  if (!claimed) {
    throw new ApiError(
      "PAYMENT_ALREADY_CLAIMED",
      "此付款授權已用於查核請求，請以新的付款授權重試。",
      409,
    );
  }
}
