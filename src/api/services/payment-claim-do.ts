const CLAIM_KEY = "payment-claim";
const MAX_DATE_MS = 8.64e15;
// 與 middleware/payment-claim.ts 的 CLAIM_TTL_MAX_MS 同步：上限防止攻擊者
// 以遙遠的 expiresAt 免費長期占用 DO 與 alarm。縱深防禦，不依賴單一檢查點。
const MAX_CLAIM_TTL_MS = 3_600_000;
const RESERVATION_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

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
    if (!["/claim", "/reserve", "/release"].includes(url.pathname)) {
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

    if (url.pathname === "/release") return this.release(body);

    const expiresAt =
      typeof body === "object" && body !== null && "expiresAt" in body ? body.expiresAt : undefined;
    if (!this.isValidExpiry(expiresAt, Date.now())) {
      return Response.json({ error: "付款授權期限無效或已過期" }, { status: 400 });
    }

    if (url.pathname === "/reserve") return this.reserve(body, expiresAt);

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

  private async reserve(body: unknown, expiresAt: number): Promise<Response> {
    const reservation = body as {
      authorizationKey?: unknown;
      reservationId?: unknown;
      amount?: unknown;
    };
    if (
      typeof reservation.authorizationKey !== "string" ||
      !/^[\da-f]{64}$/.test(reservation.authorizationKey) ||
      typeof reservation.reservationId !== "string" ||
      !RESERVATION_ID_PATTERN.test(reservation.reservationId) ||
      typeof reservation.amount !== "string" ||
      !/^[1-9]\d{0,77}$/.test(reservation.amount) ||
      BigInt(reservation.amount) > 2n ** 256n - 1n
    ) {
      return Response.json({ error: "付款進行中占位格式錯誤" }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async () => {
      if (!this.isValidExpiry(expiresAt, Date.now())) return { expired: true };
      const existing = await this.state.storage.get(CLAIM_KEY);
      if (existing !== undefined) {
        return {
          reserved: false,
          authorizationAlreadyClaimed:
            typeof existing === "object" &&
            existing !== null &&
            "authorizationKey" in existing &&
            existing.authorizationKey === reservation.authorizationKey,
        };
      }
      // 每個餘額來源使用同一顆物件；尚無可信餘額快照，因此一次只占位一筆，不按餘額推估並發數。
      await this.state.storage.put(CLAIM_KEY, { ...reservation, expiresAt });
      await this.state.storage.setAlarm(expiresAt);
      return { reserved: true, authorizationAlreadyClaimed: false };
    });
    if ("expired" in result) {
      return Response.json({ error: "付款授權期限無效或已過期" }, { status: 400 });
    }
    return Response.json(result);
  }

  private async release(body: unknown): Promise<Response> {
    const reservationId =
      typeof body === "object" && body !== null && "reservationId" in body
        ? body.reservationId
        : undefined;
    if (typeof reservationId !== "string" || !RESERVATION_ID_PATTERN.test(reservationId)) {
      return Response.json({ error: "付款進行中占位識別碼錯誤" }, { status: 400 });
    }
    const released = await this.state.storage.transaction(async () => {
      const existing = await this.state.storage.get(CLAIM_KEY);
      if (
        typeof existing !== "object" ||
        existing === null ||
        !("reservationId" in existing) ||
        existing.reservationId !== reservationId
      ) {
        return false;
      }
      // 隨機識別碼防止延遲的舊結算或釋放請求清除後來建立的新占位。
      await this.state.storage.deleteAll();
      return true;
    });
    return Response.json({ released });
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
      expiresAt > now &&
      // 拒絕遙遠未來的效期：合法 client 應在短時間內使用 authorization。
      expiresAt - now <= MAX_CLAIM_TTL_MS
    );
  }
}
