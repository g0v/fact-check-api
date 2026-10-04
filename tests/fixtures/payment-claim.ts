import type { DurableObjectNamespaceLike } from "../../src/api/types/fact-check";
import {
  PaymentClaimDO,
  type PaymentClaimStateLike,
  type PaymentClaimStorageLike,
} from "../../src/api/services/payment-claim-do";

export type PaymentClaimFixtureNamespace = DurableObjectNamespaceLike & {
  runAlarm(id: unknown): Promise<void>;
  seedClaim(id: unknown, value: Record<string, unknown>): Promise<void>;
};

class DurableMemoryStorage implements PaymentClaimStorageLike {
  private values = new Map<string, unknown>();
  private alarmTime: number | null = null;
  private transactionTail: Promise<void> = Promise.resolve();

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarmTime = null;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTime = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(async () => {
      const previousValues = new Map(this.values);
      const previousAlarmTime = this.alarmTime;
      try {
        return await operation();
      } catch (error) {
        this.values = previousValues;
        this.alarmTime = previousAlarmTime;
        throw error;
      }
    });
    this.transactionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function paymentClaimNamespace(): PaymentClaimFixtureNamespace {
  const storageById = new Map<string, DurableMemoryStorage>();
  const stateForId = (id: unknown): PaymentClaimStateLike => {
    if (typeof id !== "string") throw new TypeError("付款認領測試識別碼必須是字串");
    let storage = storageById.get(id);
    if (storage === undefined) {
      storage = new DurableMemoryStorage();
      storageById.set(id, storage);
    }
    return { storage };
  };

  return {
    idFromName(name) {
      return name;
    },
    get(id) {
      return {
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return new PaymentClaimDO(stateForId(id)).fetch(request);
        },
      };
    },
    async runAlarm(id) {
      await new PaymentClaimDO(stateForId(id)).alarm();
    },
    // 直接寫入儲存，模擬部署更新前以舊規則（無 TTL 上限）建立的 claim／占位。
    async seedClaim(id, value) {
      await stateForId(id).storage.put("payment-claim", value);
    },
  };
}
