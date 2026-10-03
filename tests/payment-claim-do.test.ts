import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PaymentClaimDO, type PaymentClaimStorageLike } from "../src/api/services/payment-claim-do";
import { paymentClaimNamespace, type PaymentClaimFixtureNamespace } from "./fixtures/payment-claim";

const FIXED_NOW = Date.UTC(2026, 0, 1);
const CLAIM_URL = "https://payment-claim/claim";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

function postClaim(namespace: PaymentClaimFixtureNamespace, id: unknown, expiresAt: unknown) {
  return namespace.get(id).fetch(CLAIM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt }),
  });
}

describe("付款認領持久物件", () => {
  it("十個並發認領中僅有一個成功", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("parallel-claim");
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => postClaim(namespace, id, FIXED_NOW + 60_000)),
    );
    const results = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
  });

  it("重建物件後仍拒絕重複認領", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("persistent-claim");

    expect((await (await postClaim(namespace, id, FIXED_NOW + 60_000)).json()).claimed).toBe(true);
    expect((await (await postClaim(namespace, id, FIXED_NOW + 90_000)).json()).claimed).toBe(false);
  });

  it("提早觸發警報時保留尚未到期的認領", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("early-alarm");

    expect((await (await postClaim(namespace, id, FIXED_NOW + 60_000)).json()).claimed).toBe(true);
    await namespace.runAlarm(id);
    expect((await (await postClaim(namespace, id, FIXED_NOW + 90_000)).json()).claimed).toBe(false);
  });

  it("到期警報清除整筆認領，使儲存可回收並允許之後的新認領", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("expired-alarm");
    const expiresAt = FIXED_NOW + 1_000;

    expect((await (await postClaim(namespace, id, expiresAt)).json()).claimed).toBe(true);
    vi.setSystemTime(expiresAt);
    await namespace.runAlarm(id);
    expect((await (await postClaim(namespace, id, expiresAt + 60_000)).json()).claimed).toBe(true);
  });

  it("舊警報不會清除其後建立且尚未到期的新認領", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("stale-alarm");
    const previousExpiresAt = FIXED_NOW + 1_000;

    expect((await (await postClaim(namespace, id, previousExpiresAt)).json()).claimed).toBe(true);
    vi.setSystemTime(previousExpiresAt);
    await namespace.runAlarm(id);

    const currentExpiresAt = previousExpiresAt + 60_000;
    expect((await (await postClaim(namespace, id, currentExpiresAt)).json()).claimed).toBe(true);
    await namespace.runAlarm(id);
    expect((await (await postClaim(namespace, id, currentExpiresAt + 60_000)).json()).claimed).toBe(
      false,
    );
  });

  it("拒絕過期、不安全整數與超出日期範圍的期限且不建立認領", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("invalid-expiry");
    const invalidExpiries = [FIXED_NOW - 1, FIXED_NOW + 0.5, 8.64e15 + 1];

    for (const expiresAt of invalidExpiries) {
      const response = await postClaim(namespace, id, expiresAt);
      expect(response.status).toBe(400);
    }
    expect((await (await postClaim(namespace, id, FIXED_NOW + 60_000)).json()).claimed).toBe(true);
  });

  it("儲存寫入失敗時拒絕請求，不回傳認領成功", async () => {
    const storageError = new Error("儲存失敗");
    const failingStorage: PaymentClaimStorageLike = {
      async get() {
        return undefined;
      },
      async put() {
        throw storageError;
      },
      async deleteAll() {},
      async setAlarm() {},
      async transaction(operation) {
        return operation();
      },
    };
    const object = new PaymentClaimDO({ storage: failingStorage });
    const request = new Request(CLAIM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresAt: FIXED_NOW + 60_000 }),
    });

    await expect(object.fetch(request)).rejects.toBe(storageError);
  });
});
