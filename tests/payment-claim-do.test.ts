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

function postReservation(
  namespace: PaymentClaimFixtureNamespace,
  id: unknown,
  authorizationKey = "a".repeat(64),
  reservationId = "00000000-0000-4000-8000-000000000001",
  expiresAt = FIXED_NOW + 60_000,
  amount: unknown = "50000",
) {
  return namespace.get(id).fetch("https://payment-claim/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorizationKey, reservationId, amount, expiresAt }),
  });
}

function postRelease(namespace: PaymentClaimFixtureNamespace, id: unknown, reservationId: string) {
  return namespace.get(id).fetch("https://payment-claim/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId }),
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

  it("預存長效 claim 經提早 alarm 後記錄仍在，進入最後 1 小時仍擋重放，到期才清除", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("legacy-long-ttl");
    // 部署更新前以舊規則（無 TTL 上限）建立的 claim：距今 2 小時。
    const longExpiresAt = FIXED_NOW + 7_200_000;
    await namespace.seedClaim(id, { expiresAt: longExpiresAt });

    await namespace.runAlarm(id);
    // 記錄仍在：短效期新 claim 被既有記錄擋下。
    expect((await (await postClaim(namespace, id, FIXED_NOW + 60_000)).json()).claimed).toBe(false);

    // 進入最後 1 小時（middleware 的 TTL 檢查此時會通過），alarm 重新安排不清除。
    vi.setSystemTime(longExpiresAt - 3_600_000 + 60_000);
    await namespace.runAlarm(id);
    expect((await (await postClaim(namespace, id, longExpiresAt)).json()).claimed).toBe(false);

    // 授權真正到期後，alarm 清除記錄，之後的新 claim 可建立。
    vi.setSystemTime(longExpiresAt + 1);
    await namespace.runAlarm(id);
    expect((await (await postClaim(namespace, id, longExpiresAt + 60_000)).json()).claimed).toBe(
      true,
    );
  });

  it("拒絕過期、不安全整數、超出日期範圍與超過 TTL 上限的期限且不建立認領", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("invalid-expiry");
    const invalidExpiries = [FIXED_NOW - 1, FIXED_NOW + 0.5, 8.64e15 + 1, FIXED_NOW + 3_600_001];

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

  it("不同 nonce 的十個並發占位也僅允許一筆，重建物件後仍保留占位", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("shared-balance");
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        postReservation(namespace, id, index.toString(16).repeat(64)),
      ),
    );
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    const winner = results.findIndex((result) => result.reserved);
    expect(
      await (await postReservation(namespace, id, winner.toString(16).repeat(64))).json(),
    ).toMatchObject({ reserved: false, authorizationAlreadyClaimed: true });
    expect(await (await postReservation(namespace, id, "f".repeat(64))).json()).toMatchObject({
      reserved: false,
      authorizationAlreadyClaimed: false,
    });
  });

  it("僅目前占位擁有者能釋放，延遲的舊釋放不會清除下一筆占位", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("reservation-owner");
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    expect(
      (await (await postReservation(namespace, id, "a".repeat(64), firstId)).json()).reserved,
    ).toBe(true);
    expect((await (await postRelease(namespace, id, secondId)).json()).released).toBe(false);
    expect(
      (await (await postReservation(namespace, id, "b".repeat(64), secondId)).json()).reserved,
    ).toBe(false);
    expect((await (await postRelease(namespace, id, firstId)).json()).released).toBe(true);
    expect(
      (await (await postReservation(namespace, id, "b".repeat(64), secondId)).json()).reserved,
    ).toBe(true);
    expect((await (await postRelease(namespace, id, firstId)).json()).released).toBe(false);
    expect((await (await postReservation(namespace, id)).json()).reserved).toBe(false);
  });

  it("占位保留到完整授權期限，提早或舊 alarm 不會放行下一筆", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("reservation-expiry");
    const expiresAt = FIXED_NOW + 60_000;
    expect((await (await postReservation(namespace, id)).json()).reserved).toBe(true);
    vi.setSystemTime(FIXED_NOW + 30_000);
    await namespace.runAlarm(id);
    expect((await (await postReservation(namespace, id, "b".repeat(64))).json()).reserved).toBe(
      false,
    );
    vi.setSystemTime(expiresAt);
    await namespace.runAlarm(id);
    expect(
      (
        await (
          await postReservation(namespace, id, "b".repeat(64), undefined, expiresAt + 60_000)
        ).json()
      ).reserved,
    ).toBe(true);
    await namespace.runAlarm(id);
    expect(
      (
        await (
          await postReservation(namespace, id, "c".repeat(64), undefined, expiresAt + 60_000)
        ).json()
      ).reserved,
    ).toBe(false);
  });

  it("占位拒絕超過 TTL 上限的期限且不占用地址", async () => {
    const namespace = paymentClaimNamespace();
    const id = namespace.idFromName("reservation-ttl-cap");
    const response = await postReservation(
      namespace,
      id,
      "d".repeat(64),
      undefined,
      FIXED_NOW + 3_600_001,
    );
    expect(response.status).toBe(400);
    expect((await (await postReservation(namespace, id)).json()).reserved).toBe(true);
  });

  it.each(["0", "-1", "1.5", "01", (2n ** 256n).toString(), null])(
    "拒絕無效占位金額 %s，且不占用地址",
    async (amount) => {
      const namespace = paymentClaimNamespace();
      const id = namespace.idFromName("invalid-reservation");
      expect(
        (await postReservation(namespace, id, undefined, undefined, undefined, amount)).status,
      ).toBe(400);
      expect((await (await postReservation(namespace, id)).json()).reserved).toBe(true);
    },
  );
});
