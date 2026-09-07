import { BUDGET } from "../config";
import { communityPolicy } from "../prompts/community-policy";
import { synthesisPrompt } from "../prompts/fact-check";
import { relevancePrompt } from "../prompts/relevance-filter";
import type { ApiBindings } from "../types/fact-check";
import { ApiError } from "../utils/errors";
import { readLimitedText, withTimeout } from "../utils/http";
import type { Logger } from "../utils/logging";
import { estimateTokens, usageCostUsd } from "../utils/usage";
import { finiteNumber, record } from "../utils/validation";

// 議題 #9：所有查核共用同一個 Durable Object，以固定的 UTC 整點小時為記帳區間。
export const HOUR_MS = 3_600_000;
const LEDGER_KEY = "ledger";
const OBJECT_NAME = "global";

export type BudgetLedger = {
  bucket: number;
  spentUsd: number;
  requests: number;
  rejected: number;
};
export type BudgetCommand =
  | { action: "reserve"; amountUsd: number; limitUsd: number }
  | { action: "settle"; bucket: number; deltaUsd: number };
export type BudgetStatus = {
  allowed: boolean;
  bucket: number;
  spentUsd: number;
  limitUsd: number | null;
  resetAt: number;
  requests: number;
  rejected: number;
};

function usd(value: number): number {
  return Math.max(0, Math.round(value * 1e9) / 1e9);
}

function emptyLedger(bucket: number): BudgetLedger {
  return { bucket, spentUsd: 0, requests: 0, rejected: 0 };
}

export function parseBudgetCommand(value: unknown): BudgetCommand {
  const data = record(value);
  if (data.action === "reserve") {
    const amountUsd = finiteNumber(data.amountUsd);
    const limitUsd = finiteNumber(data.limitUsd);
    if (amountUsd < 0 || limitUsd < 0) throw new Error("金額不得為負數。");
    return { action: "reserve", amountUsd, limitUsd };
  }
  if (data.action === "settle") {
    const bucket = finiteNumber(data.bucket);
    if (!Number.isSafeInteger(bucket)) throw new Error("記帳區間不正確。");
    return { action: "settle", bucket, deltaUsd: finiteNumber(data.deltaUsd) };
  }
  throw new Error("未知的預算操作。");
}

// 純函式：套用指令並回傳新帳本與狀態，方便單元測試；Durable Object 只負責持久化。
export function applyBudgetCommand(
  current: BudgetLedger | undefined,
  command: BudgetCommand,
  now: number,
): { ledger: BudgetLedger; status: BudgetStatus } {
  const bucket = Math.floor(now / HOUR_MS);
  const ledger = current && current.bucket === bucket ? { ...current } : emptyLedger(bucket);
  let allowed = true;
  let limitUsd: number | null = null;
  if (command.action === "reserve") {
    limitUsd = command.limitUsd;
    // 預留後總額不得超過上限；上限為 0 時一律拒絕。
    allowed = usd(ledger.spentUsd + command.amountUsd) <= limitUsd && limitUsd > 0;
    if (allowed) {
      ledger.spentUsd = usd(ledger.spentUsd + command.amountUsd);
      ledger.requests += 1;
    } else ledger.rejected += 1;
  } else if (command.bucket === bucket) {
    // 只結算同一小時內的預留；跨整點的差額不追溯也不抵扣新區間。
    ledger.spentUsd = usd(ledger.spentUsd + command.deltaUsd);
  }
  return {
    ledger,
    status: {
      allowed,
      bucket,
      spentUsd: ledger.spentUsd,
      limitUsd,
      resetAt: (bucket + 1) * HOUR_MS,
      requests: ledger.requests,
      rejected: ledger.rejected,
    },
  };
}

export type BudgetStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};
export type BudgetObjectState = { storage: BudgetStorage };

// Durable Object：同一物件內的請求依序處理，讀取、判斷與寫入之間不會交錯。
export class UsageBudget {
  constructor(private readonly state: BudgetObjectState) {}

  async fetch(request: Request): Promise<Response> {
    let command: BudgetCommand;
    try {
      if (request.method !== "POST") throw new Error("只接受 POST。");
      command = parseBudgetCommand(JSON.parse(await request.text()));
    } catch {
      return Response.json({ error: "預算指令格式不正確。" }, { status: 400 });
    }
    const current = await this.state.storage.get<BudgetLedger>(LEDGER_KEY);
    const { ledger, status } = applyBudgetCommand(current, command, Date.now());
    await this.state.storage.put(LEDGER_KEY, ledger);
    return Response.json(status);
  }
}

export function resolveHourlyLimitUsd(env: ApiBindings): number {
  const raw = env.HOURLY_BUDGET_USD;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : BUDGET.hourlyUsd;
  if (typeof raw !== "string" || !raw.trim()) return BUDGET.hourlyUsd;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : BUDGET.hourlyUsd;
}

// 以輸入長度與典型候選、證據量估算一次未命中快取的查核費用；實際用量於結算時修正。
export function estimateRequestCostUsd(text: string): number {
  const textTokens = estimateTokens(text);
  const typical = BUDGET.typicalTokens;
  return (
    usageCostUsd(
      "moderation",
      estimateTokens(communityPolicy) + textTokens,
      typical.moderationOutput,
    ) +
    usageCostUsd(
      "relevance",
      estimateTokens(relevancePrompt) + textTokens + typical.candidates,
      typical.relevanceOutput,
    ) +
    usageCostUsd(
      "synthesis",
      estimateTokens(synthesisPrompt) + textTokens + typical.evidence,
      typical.synthesisOutput,
    )
  );
}

function parseBudgetStatus(value: unknown): BudgetStatus {
  const data = record(value);
  const bucket = finiteNumber(data.bucket);
  if (typeof data.allowed !== "boolean" || !Number.isSafeInteger(bucket))
    throw new Error("預算狀態格式不正確。");
  return {
    allowed: data.allowed,
    bucket,
    spentUsd: finiteNumber(data.spentUsd),
    limitUsd: data.limitUsd === null ? null : finiteNumber(data.limitUsd),
    resetAt: finiteNumber(data.resetAt),
    requests: finiteNumber(data.requests),
    rejected: finiteNumber(data.rejected),
  };
}

async function sendBudgetCommand(
  env: ApiBindings,
  command: BudgetCommand,
): Promise<BudgetStatus | null> {
  const namespace = env.USAGE_BUDGET;
  if (!namespace) return null;
  return withTimeout(async (signal) => {
    const stub = namespace.get(namespace.idFromName(OBJECT_NAME));
    const response = await stub.fetch("https://usage-budget/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal,
    });
    const body = await readLimitedText(response.body, 10_000, signal);
    if (!response.ok) throw new Error("預算服務回應失敗。");
    return parseBudgetStatus(JSON.parse(body));
  }, BUDGET.timeoutMs);
}

export function budgetExceededError(status: BudgetStatus): ApiError {
  const retryAfterSeconds = Math.max(1, Math.ceil((status.resetAt - Date.now()) / 1000));
  return new ApiError(
    "BUDGET_EXCEEDED",
    "本小時的查核用量已達上限，請稍後再試。",
    429,
    undefined,
    false,
    retryAfterSeconds,
  );
}

export type BudgetReservation = { bucket: number; amountUsd: number; status: BudgetStatus };

// 未設定 Durable Object binding（例如 Node 單元測試）時略過；服務失敗則拒絕查核以確保不超支。
export async function reserveHourlyBudget(
  env: ApiBindings,
  text: string,
  requestId: string,
  log: Logger,
): Promise<BudgetReservation | null> {
  const amountUsd = estimateRequestCostUsd(text);
  const limitUsd = resolveHourlyLimitUsd(env);
  let status: BudgetStatus | null;
  try {
    status = await sendBudgetCommand(env, { action: "reserve", amountUsd, limitUsd });
  } catch {
    log({ event: "budget", request_id: requestId, operation: "reserve", status: "error" });
    throw new ApiError("BUDGET_UNAVAILABLE", "查核用量控管服務暫時無法使用，請稍後再試。", 503);
  }
  if (!status) {
    log({ event: "budget", request_id: requestId, operation: "reserve", status: "bypass" });
    return null;
  }
  log({
    event: "budget",
    request_id: requestId,
    operation: "reserve",
    status: status.allowed ? "allowed" : "rejected",
    reserved_usd: amountUsd,
    spent_usd: status.spentUsd,
    limit_usd: limitUsd,
    reset_at: new Date(status.resetAt).toISOString(),
    hour_requests: status.requests,
    hour_rejected: status.rejected,
  });
  if (!status.allowed) throw budgetExceededError(status);
  return { bucket: status.bucket, amountUsd, status };
}

// 以實際用量修正預留金額；結算失敗只記錄，不影響已完成的查核結果。
export async function settleHourlyBudget(
  env: ApiBindings,
  reservation: BudgetReservation,
  actualUsd: number,
  requestId: string,
  log: Logger,
): Promise<void> {
  const deltaUsd = actualUsd - reservation.amountUsd;
  try {
    const status = await sendBudgetCommand(env, {
      action: "settle",
      bucket: reservation.bucket,
      deltaUsd,
    });
    log({
      event: "budget",
      request_id: requestId,
      operation: "settle",
      status: status ? "settled" : "bypass",
      actual_usd: actualUsd,
      delta_usd: deltaUsd,
      spent_usd: status?.spentUsd ?? null,
    });
  } catch {
    log({ event: "budget", request_id: requestId, operation: "settle", status: "error" });
  }
}
