import type { DurableObjectNamespaceLike } from "../../src/api/types/fact-check";
import {
  RateLimiterDO,
  type RateLimiterStateLike,
  type RateLimiterStorageLike,
} from "../../src/api/services/rate-limiter-do";

class RateLimiterMemoryStorage implements RateLimiterStorageLike {
  private values = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(async () => {
      const previousValues = new Map(this.values);
      try {
        return await operation();
      } catch (error) {
        this.values = previousValues;
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

export function rateLimiterState(): RateLimiterStateLike {
  return { storage: new RateLimiterMemoryStorage() };
}

export function rateLimitNamespace(): DurableObjectNamespaceLike {
  const stateById = new Map<unknown, RateLimiterStateLike>();
  return {
    idFromName: (name) => name,
    get(id) {
      let state = stateById.get(id);
      if (!state) {
        state = rateLimiterState();
        stateById.set(id, state);
      }
      const durableState = state;
      return {
        // 每次請求重建物件，僅保留儲存，模擬閒置回收或重新啟動。
        fetch: (input, init) => new RateLimiterDO(durableState).fetch(new Request(input, init)),
      };
    },
  };
}
