import type { DurableObjectNamespaceLike } from "../../src/api/types/fact-check";
import { MppStoreDO } from "../../src/api/services/mpp-store-do";
import { DurableMemoryStorage } from "./payment-claim";

export type MppStoreFixtureNamespace = DurableObjectNamespaceLike & {
  runAlarm(id: unknown): Promise<void>;
};

export function mppStoreNamespace(): MppStoreFixtureNamespace {
  const storageById = new Map<string, DurableMemoryStorage>();
  const stateForId = (id: unknown) => {
    if (typeof id !== "string") throw new TypeError("MPP 儲存測試識別碼必須是字串");
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
          return new MppStoreDO(stateForId(id)).fetch(request);
        },
      };
    },
    async runAlarm(id) {
      await new MppStoreDO(stateForId(id)).alarm();
    },
  };
}
