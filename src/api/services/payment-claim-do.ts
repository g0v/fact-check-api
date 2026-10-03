const CLAIM_KEY = "payment-claim";
const MAX_DATE_MS = 8.64e15;

// 僅描述本服務實際使用的物件狀態，避免依賴此專案未提供的 Worker 全域型別。
export type PaymentClaimStorageLike = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
};

export type PaymentClaimStateLike = { storage: PaymentClaimStorageLike };

export class PaymentClaimDO {
  constructor(private readonly state: PaymentClaimStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/claim") {
      return Response.json({ error: "找不到付款認領端點" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "付款認領僅接受 POST 請求" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "付款授權期限格式錯誤" }, { status: 400 });
    }

    const expiresAt =
      typeof body === "object" && body !== null && "expiresAt" in body ? body.expiresAt : undefined;
    if (!this.isValidExpiry(expiresAt, Date.now())) {
      return Response.json({ error: "付款授權期限無效或已過期" }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async () => {
      // 等待儲存佇列期間授權可能到期，提交前再次確認。
      if (!this.isValidExpiry(expiresAt, Date.now())) return "expired" as const;

      const existing = await this.state.storage.get(CLAIM_KEY);
      if (existing !== undefined) return "claimed" as const;

      await this.state.storage.put(CLAIM_KEY, { expiresAt });
      await this.state.storage.setAlarm(expiresAt);
      return "created" as const;
    });

    if (result === "expired") {
      return Response.json({ error: "付款授權期限無效或已過期" }, { status: 400 });
    }
    return Response.json({ claimed: result === "created" });
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async () => {
      const currentClaim = await this.state.storage.get(CLAIM_KEY);
      if (currentClaim === undefined) return;

      if (
        typeof currentClaim === "object" &&
        currentClaim !== null &&
        "expiresAt" in currentClaim &&
        this.isValidExpiry(currentClaim.expiresAt, Date.now())
      ) {
        // 提早觸發或舊警報到達時，依目前記錄重新安排，不清除尚有效的認領。
        await this.state.storage.setAlarm(currentClaim.expiresAt);
        return;
      }

      // SQLite 儲存刪除所有資料時，也會移除已過期認領與警報。
      await this.state.storage.deleteAll();
    });
  }

  private isValidExpiry(expiresAt: unknown, now: number): expiresAt is number {
    return (
      typeof expiresAt === "number" &&
      Number.isSafeInteger(expiresAt) &&
      Math.abs(expiresAt) <= MAX_DATE_MS &&
      expiresAt > now
    );
  }
}
