export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("資料必須為物件。");
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("資料必須為陣列。");
  return value;
}

export function string(value: unknown, max = 20_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error("文字格式不正確。");
  }
  return value.trim();
}

export function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("文字格式不正確。");
  return value.trim() || undefined;
}

export function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("數值格式不正確。");
  return value;
}

export function unitNumber(value: unknown): number {
  const result = finiteNumber(value);
  if (result < 0 || result > 1) throw new Error("數值必須介於 0 與 1。");
  return result;
}

export function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error("分類值不正確。");
  return value as T[number];
}
