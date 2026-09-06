import { fetchJson, type Fetcher } from "../utils/http";
import { record } from "../utils/validation";

export async function queryCofacts(
  query: string,
  variables: Record<string, string>,
  fetcher: Fetcher,
): Promise<Record<string, unknown>> {
  const output = record(
    await fetchJson(fetcher, "https://api.cofacts.tw/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  if (output.errors !== undefined && (!Array.isArray(output.errors) || output.errors.length)) {
    throw new Error("Cofacts 查詢失敗。");
  }
  return record(output.data);
}
