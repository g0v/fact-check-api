import { BUDGET } from "../config";
import { synthesisPrompt } from "../prompts/fact-check";
import { relevancePrompt } from "../prompts/relevance-filter";
import type { ApiBindings } from "../types/fact-check";
import { ApiError } from "../utils/errors";
import { readLimitedText, withTimeout } from "../utils/http";
import type { Logger } from "../utils/logging";
import { estimateTokens, usageNeurons } from "../utils/usage";
import { finiteNumber, record } from "../utils/validation";

// 議題 #9：所有查核共用同一個 Durable Object，以 UTC 日為記帳區間，對齊 Workers AI 每日免費額度。
export const DAY_MS = 86_400_000;
const LEDGER_KEY = "ledger";
const OBJECT_NAME = "global";

export type BudgetLedger = {
  bucket: number;
  spentNeurons: number;
  requests: number;
  rejected: number;
};
export type BudgetCommand =
  | { action: "reserve"; amountNeurons: number; limitNeurons: number }
  | { action: "settle"; bucket: number; deltaNeurons: number };
export type BudgetStatus = {
  allowed: boolean;
  bucket: number;
  spentNeurons: number;
  limitNeurons: number | null;
  resetAt: number;
  requests: number;
  rejected: number;
};

function neurons(value: number): number {
  return Math.max(0, Math.round(value * 1e6) / 1e6);
}

function emptyLedger(bucket: number): BudgetLedger {
  return { bucket, spentNeurons: 0, requests: 0, rejected: 0 };
}

export function parseBudgetCommand(value: unknown): BudgetCommand {
  const data = record(value);
  if (data.action === "reserve") {
    const amountNeurons = finiteNumber(data.amountNeurons);
    const limitNeurons = finiteNumber(data.limitNeurons);
    if (amountNeurons < 0 || limitNeurons < 0) throw new Error("用量不得為負數。");
    return { action: "reserve", amountNeurons, limitNeurons };
  }
  if (data.action === "settle") {
    const bucket = finiteNumber(data.bucket);
    if (!Number.isSafeInteger(bucket)) throw new Error("記帳區間不正確。");
    return { action: "settle", bucket, deltaNeurons: finiteNumber(data.deltaNeurons) };
  }
  throw new Error("未知的預算操作。");
}

// 純函式：套用指令並回傳新帳本與狀態，方便單元測試；Durable Object 只負責持久化。
export function applyBudgetCommand(
  current: BudgetLedger | undefined,
  command: BudgetCommand,
  now: number,
): { ledger: BudgetLedger; status: BudgetStatus } {
  const bucket = Math.floor(now / DAY_MS);
  const ledger = current && current.bucket === bucket ? { ...current } : emptyLedger(bucket);
  let allowed = true;
  let limitNeurons: number | null = null;
  if (command.action === "reserve") {
    limitNeurons = command.limitNeurons;
    // 預留後總額不得超過上限；上限為 0 時一律拒絕。
    allowed =
      neurons(ledger.spentNeurons + command.amountNeurons) <= limitNeurons && limitNeurons > 0;
    if (allowed) {
      ledger.spentNeurons = neurons(ledger.spentNeurons + command.amountNeurons);
      ledger.requests += 1;
    } else ledger.rejected += 1;
  } else if (command.bucket === bucket) {
    // 只結算同一天內的預留；跨日的差額不追溯也不抵扣新區間。
    ledger.spentNeurons = neurons(ledger.spentNeurons + command.deltaNeurons);
  }
  return {
    ledger,
    status: {
      allowed,
      bucket,
      spentNeurons: ledger.spentNeurons,
      limitNeurons,
      resetAt: (bucket + 1) * DAY_MS,
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

export function resolveDailyLimitNeurons(env: ApiBindings): number {
  const raw = env.DAILY_NEURON_BUDGET;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : BUDGET.dailyNeurons;
  if (typeof raw !== "string" || !raw.trim()) return BUDGET.dailyNeurons;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : BUDGET.dailyNeurons;
}

// 以輸入長度與典型候選、證據量估算一次未命中快取的 Workers AI 用量；實際用量於結算時修正。
export function estimateRequestNeurons(text: string): number {
  const textTokens = estimateTokens(text);
  const typical = BUDGET.typicalTokens;
  return (
    usageNeurons(
      "relevance",
      estimateTokens(relevancePrompt) + textTokens + typical.candidates,
      typical.relevanceOutput,
    ) +
    usageNeurons(
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
    spentNeurons: finiteNumber(data.spentNeurons),
    limitNeurons: data.limitNeurons === null ? null : finiteNumber(data.limitNeurons),
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
    "今日的查核用量已達上限，請於 UTC 隔日再試。",
    429,
    undefined,
    false,
    retryAfterSeconds,
  );
}

export type BudgetReservation = { bucket: number; amountNeurons: number; status: BudgetStatus };

// 未設定 Durable Object binding（例如 Node 單元測試）時略過；服務失敗則拒絕查核以確保不超支。
export async function reserveDailyBudget(
  env: ApiBindings,
  text: string,
  requestId: string,
  log: Logger,
): Promise<BudgetReservation | null> {
  const amountNeurons = estimateRequestNeurons(text);
  const limitNeurons = resolveDailyLimitNeurons(env);
  let status: BudgetStatus | null;
  try {
    status = await sendBudgetCommand(env, { action: "reserve", amountNeurons, limitNeurons });
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
    reserved_neurons: amountNeurons,
    spent_neurons: status.spentNeurons,
    limit_neurons: limitNeurons,
    reset_at: new Date(status.resetAt).toISOString(),
    day_requests: status.requests,
    day_rejected: status.rejected,
  });
  if (!status.allowed) throw budgetExceededError(status);
  return { bucket: status.bucket, amountNeurons, status };
}

// 以實際用量修正預留額度；結算失敗只記錄，不影響已完成的查核結果。
export async function settleDailyBudget(
  env: ApiBindings,
  reservation: BudgetReservation,
  actualNeurons: number,
  requestId: string,
  log: Logger,
): Promise<void> {
  const deltaNeurons = actualNeurons - reservation.amountNeurons;
  try {
    const status = await sendBudgetCommand(env, {
      action: "settle",
      bucket: reservation.bucket,
      deltaNeurons,
    });
    log({
      event: "budget",
      request_id: requestId,
      operation: "settle",
      status: status ? "settled" : "bypass",
      actual_neurons: actualNeurons,
      delta_neurons: deltaNeurons,
      spent_neurons: status?.spentNeurons ?? null,
    });
  } catch {
    log({ event: "budget", request_id: requestId, operation: "settle", status: "error" });
  }
}
