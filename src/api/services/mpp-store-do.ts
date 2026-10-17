import type { PaymentClaimStateLike } from "./payment-claim-do";

const RECORD_KEY = "record";
const MAX_DATE_MS = 8.64e15;
// mppx 只為已通過驗證的 challenge 寫入重放標記，效期跟隨 challenge；上限防止遙遠效期長期占用物件。
const MAX_REPLAY_TTL_MS = 86_400_000;
const REPLAY_MARKER_TYPE = "mppx:replay";

type StoredRecord = { value: string; version: number; expiresAt?: number };

// mppx Store 的持久化後端：每個 key 一顆物件，提供讀取、版本比對寫入與重放標記 claim。
// 跨 isolate 的原子性由 Durable Object 單執行緒與 transaction() 保證。
export class MppStoreDO {
  constructor(private readonly state: PaymentClaimStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!["/get", "/cas", "/claim"].includes(url.pathname)) {
      return Response.json({ error: "找不到 MPP 儲存端點" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "MPP 儲存僅接受 POST 請求" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null) throw new Error("格式錯誤");
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "MPP 儲存請求格式錯誤" }, { status: 400 });
    }

    if (url.pathname === "/get") {
      const record = await this.current();
      return Response.json(
        record ? { value: record.value, version: record.version } : { value: null, version: 0 },
      );
    }
    if (url.pathname === "/claim") return this.claim(body.expires);
    return this.compareAndSet(body);
  }

  private async claim(expires: unknown): Promise<Response> {
    if (!this.isNewExpiryValid(expires, Date.now())) {
      return Response.json({ error: "重放標記期限無效或已過期" }, { status: 400 });
    }
    const claimed = await this.state.storage.transaction(async () => {
      const record = await this.current();
      if (record && !(record.expiresAt !== undefined && record.expiresAt <= Date.now()))
        return false;
      await this.write({
        value: JSON.stringify({ expires, type: REPLAY_MARKER_TYPE }),
        version: (record?.version ?? 0) + 1,
        expiresAt: expires,
      });
      return true;
    });
    return Response.json({ claimed });
  }

  private async compareAndSet(body: Record<string, unknown>): Promise<Response> {
    const { version, op, value } = body;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      (op !== "set" && op !== "delete") ||
      (op === "set" && typeof value !== "string")
    ) {
      return Response.json({ error: "MPP 儲存寫入格式錯誤" }, { status: 400 });
    }
    let expiresAt: number | undefined;
    if (op === "set") {
      expiresAt = replayMarkerExpiry(value as string);
      if (expiresAt !== undefined && !this.isNewExpiryValid(expiresAt, Date.now())) {
        return Response.json({ error: "重放標記期限無效或已過期" }, { status: 400 });
      }
    }
    const ok = await this.state.storage.transaction(async () => {
      const record = await this.current();
      if ((record?.version ?? 0) !== version) return false;
      if (op === "delete") {
        await this.state.storage.delete(RECORD_KEY);
        await this.state.storage.deleteAlarm();
        return true;
      }
      await this.write({ value: value as string, version: version + 1, expiresAt });
      return true;
    });
    return Response.json({ ok });
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async () => {
      const record = await this.current();
      if (record?.expiresAt === undefined) return;
      if (record.expiresAt > Date.now()) {
        await this.state.storage.setAlarm(record.expiresAt);
        return;
      }
      await this.state.storage.delete(RECORD_KEY);
      await this.state.storage.deleteAlarm();
    });
  }

  private async current(): Promise<StoredRecord | undefined> {
    const stored = await this.state.storage.get(RECORD_KEY);
    if (
      typeof stored !== "object" ||
      stored === null ||
      typeof (stored as StoredRecord).value !== "string" ||
      typeof (stored as StoredRecord).version !== "number"
    ) {
      return undefined;
    }
    return stored as StoredRecord;
  }

  private async write(record: StoredRecord): Promise<void> {
    await this.state.storage.put(RECORD_KEY, record);
    // 只有重放標記會到期；一般值不設警報，覆寫為一般值時移除舊警報。
    if (record.expiresAt === undefined) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(record.expiresAt);
  }

  private isNewExpiryValid(expires: unknown, now: number): expires is number {
    return (
      typeof expires === "number" &&
      Number.isSafeInteger(expires) &&
      Math.abs(expires) <= MAX_DATE_MS &&
      expires > now &&
      expires - now <= MAX_REPLAY_TTL_MS
    );
  }
}

function replayMarkerExpiry(value: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === REPLAY_MARKER_TYPE &&
      "expires" in parsed &&
      typeof parsed.expires === "number"
    ) {
      return parsed.expires;
    }
  } catch {
    // 非 JSON 值視為一般資料，不設到期。
  }
  return undefined;
}
