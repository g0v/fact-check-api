import { LIMITS, MODELS, RESULT_CACHE } from "../config";
import { communityPolicy } from "../prompts/community-policy";
import { synthesisPrompt } from "../prompts/fact-check";
import { relevancePrompt } from "../prompts/relevance-filter";
import { parseModeration, parseSynthesis } from "../schemas/fact-check";
import type { ApiBindings, FactCheckInput, FactCheckResponse } from "../types/fact-check";
import { readLimitedText, withTimeout, type Fetcher } from "../utils/http";
import type { Logger } from "../utils/logging";
import { array, enumValue, record, string, unitNumber } from "../utils/validation";
import { factCheck } from "./fact-check";

export type ResultCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};
type CachedResult = Omit<FactCheckResponse, "text" | "url" | "meta"> & {
  meta: Omit<FactCheckResponse["meta"], "request_id" | "cache">;
};
type CacheEntry = { version: string; cachedAt: number; result: CachedResult };

export async function createResultCacheKey(
  input: FactCheckInput,
  origin: string,
): Promise<Request> {
  // 只合併經過 parseInput 正規化後完全相同的輸入，不合併近義句或移除內文空白。
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: RESULT_CACHE.version,
      models: MODELS,
      limits: LIMITS,
      prompts: [communityPolicy, relevancePrompt, synthesisPrompt],
      text: input.text,
      url: input.url ?? null,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // 命名 Cache 與對外路由分離；鍵不含使用者原文、網址或 credential。
  return new Request(new URL(`/__fact-check-cache/${RESULT_CACHE.version}/${hash}`, origin), {
    method: "GET",
  });
}

function parseCacheEntry(value: unknown): CacheEntry {
  const entry = record(value);
  const result = record(entry.result);
  const meta = record(result.meta);
  if (
    entry.version !== RESULT_CACHE.version ||
    typeof entry.cachedAt !== "number" ||
    !Number.isSafeInteger(entry.cachedAt) ||
    entry.cachedAt > Date.now() ||
    entry.cachedAt + RESULT_CACHE.ttlSeconds * 1000 <= Date.now() ||
    result.status !== "completed" ||
    array(meta.warnings).length !== 0 ||
    typeof meta.url_context_used !== "boolean"
  )
    throw new Error("快取已過期或格式不正確。");
  for (const key of [
    "cofacts_candidates",
    "cofacts_relevant",
    "cofacts_human_checks",
    "cofacts_ai_checks",
  ]) {
    if (typeof meta[key] !== "number" || !Number.isSafeInteger(meta[key]) || meta[key] < 0)
      throw new Error("快取計數不正確。");
  }
  if (parseModeration(result.moderation).decision === "block")
    throw new Error("不可採用封鎖結果的快取。");
  const checks = array(result.related_checks);
  parseSynthesis(result, checks.length > 0 || meta.url_context_used);
  for (const value of checks) {
    const check = record(value);
    enumValue(check.type, ["cofacts_human", "cofacts_ai"]);
    string(check.text, LIMITS.evidenceText);
    string(check.url, LIMITS.url);
    for (const key of ["reference_url", "classification"]) {
      if (check[key] !== undefined) string(check[key], LIMITS.url);
    }
    if (check.reference_urls !== undefined)
      array(check.reference_urls).forEach((url) => string(url, LIMITS.url));
    if (
      check.retrieval_score !== undefined &&
      (typeof check.retrieval_score !== "number" || !Number.isFinite(check.retrieval_score))
    )
      throw new Error("快取搜尋分數不正確。");
    if (check.relevance_score !== undefined) unitNumber(check.relevance_score);
  }
  return value as CacheEntry;
}

export async function cachedFactCheck(
  input: FactCheckInput,
  env: ApiBindings,
  options: {
    origin: string;
    requestId?: string;
    fetcher?: Fetcher;
    log?: Logger;
    cache?: ResultCache | null;
    waitUntil?: (task: Promise<void>) => void;
  },
): Promise<FactCheckResponse> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const log: Logger = options.log ?? ((event) => console.info(JSON.stringify(event)));
  const cacheLog = (status: string, operation: string) =>
    log({ event: "cache", request_id: requestId, status, operation });
  let cache: ResultCache | undefined;
  let key: Request | undefined;
  let cacheStatus: "miss" | "bypass" = "bypass";
  try {
    cache =
      options.cache === null
        ? undefined
        : (options.cache ??
          (typeof caches === "undefined"
            ? undefined
            : await withTimeout(
                () => caches.open(RESULT_CACHE.namespace),
                RESULT_CACHE.timeoutMs,
              )));
    if (cache) {
      key = await createResultCacheKey(input, options.origin);
      cacheStatus = "miss";
      const entry = await withTimeout(async (signal) => {
        const response = await cache!.match(key!);
        if (!response) return null;
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        return parseCacheEntry(
          JSON.parse(await readLimitedText(response.body, LIMITS.upstreamBytes, signal)),
        );
      }, RESULT_CACHE.timeoutMs);
      if (entry) {
        cacheLog("hit", "read");
        return {
          ...entry.result,
          ...input,
          meta: {
            ...entry.result.meta,
            request_id: requestId,
            cache: {
              status: "hit",
              cached_at: new Date(entry.cachedAt).toISOString(),
              expires_at: new Date(entry.cachedAt + RESULT_CACHE.ttlSeconds * 1000).toISOString(),
            },
          },
        };
      }
      cacheLog("miss", "read");
    } else cacheLog("bypass", "read");
  } catch {
    // 快取損壞、過期或服務失敗都回到原查核；不記錄例外內容或查核原文。
    cacheLog("error", "read");
  }

  const result = await factCheck(input, env, { ...options, requestId, log });
  if (cache && key && result.status === "completed" && result.meta.warnings.length === 0) {
    const { request_id: _requestId, cache: _cache, ...meta } = result.meta;
    const { text: _text, url: _url, meta: _meta, ...content } = result;
    const entry: CacheEntry = {
      version: RESULT_CACHE.version,
      cachedAt: Date.now(),
      result: { ...content, meta },
    };
    const write = async () => {
      try {
        const body = JSON.stringify(entry);
        if (new TextEncoder().encode(body).byteLength > LIMITS.upstreamBytes) {
          cacheLog("bypass", "write");
          return;
        }
        await withTimeout(
          () =>
            cache!.put(
              key!,
              new Response(body, {
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": `public, max-age=${RESULT_CACHE.ttlSeconds}`,
                },
              }),
            ),
          RESULT_CACHE.timeoutMs,
        );
        cacheLog("stored", "write");
      } catch {
        cacheLog("error", "write");
      }
    };
    const task = write();
    if (options.waitUntil) {
      try {
        options.waitUntil(task);
      } catch {
        cacheLog("error", "schedule");
        await task;
      }
    } else await task;
  } else cacheLog("bypass", "write");
  return { ...result, meta: { ...result.meta, cache: { status: cacheStatus } } };
}
