import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const source = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

describe("Workers 原生 Durable Object 預算控管", () => {
  it("透過真實 binding 預留、結算並在超過上限時拒絕", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fact-check-budget-"));
    try {
      const entry = join(directory, "entry.js");
      await writeFile(
        entry,
        `
import {
  UsageBudget,
  reserveHourlyBudget,
  settleHourlyBudget,
} from ${source("../src/api/services/usage-budget.ts")};

export { UsageBudget };
export default { async test(_controller, env) {
  const logs = [];
  const log = (event) => logs.push(event);
  const limited = { ...env, HOURLY_BUDGET_USD: "0.005" };
  const first = await reserveHourlyBudget(limited, "測試主張", "first", log);
  if (!first || !first.status.allowed) throw new Error("第一次預留未通過。");
  if (first.status.limitUsd !== 0.005) throw new Error("上限未傳入 Durable Object。");
  await settleHourlyBudget(limited, first, 0.02, "first", log);
  const settled = logs.find((event) => event.operation === "settle");
  if (!settled || settled.status !== "settled" || settled.spent_usd < 0.02) {
    throw new Error("結算未寫入實際用量。");
  }
  let rejected = false;
  try {
    await reserveHourlyBudget(limited, "測試主張", "second", log);
  } catch (error) {
    rejected =
      error.code === "BUDGET_EXCEEDED" && error.status === 429 && error.retryAfterSeconds >= 1;
  }
  if (!rejected) throw new Error("超過上限時未拒絕。");
  if (!logs.some((event) => event.status === "rejected" && event.hour_rejected === 1)) {
    throw new Error("未記錄拒絕次數。");
  }
  if (JSON.stringify(logs).includes("測試主張")) throw new Error("紀錄含有原文。");
  console.log("BUDGET_WORKER_OK");
} };
`,
      );
      // 僅打包明確指定的程式碼，不載入專案設定或環境檔。
      const bundle = await build({
        configFile: false,
        root: directory,
        envDir: false,
        publicDir: false,
        logLevel: "silent",
        ssr: { noExternal: true },
        build: {
          ssr: true,
          write: false,
          minify: false,
          target: "es2022",
          rollupOptions: { input: entry, output: { inlineDynamicImports: true } },
        },
      });
      if (Array.isArray(bundle) || !("output" in bundle)) throw new Error("測試打包格式不正確。");
      const chunks = bundle.output.filter((item) => item.type === "chunk");
      expect(chunks).toHaveLength(1);
      await writeFile(join(directory, "test.js"), chunks[0].code);
      // Durable Object 儲存在記憶體；不開 socket、不連網、不使用真實 secret。
      await writeFile(
        join(directory, "config.capnp"),
        `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [
  (name = "budget-test", worker = (
    modules = [(name = "test.js", esModule = embed "test.js")],
    compatibilityDate = "2026-04-17",
    durableObjectNamespaces = [(className = "UsageBudget", uniqueKey = "fact-check-usage-budget-test")],
    durableObjectStorage = (inMemory = void),
    bindings = [(name = "USAGE_BUDGET", durableObjectNamespace = "UsageBudget")]
  ))
]);
`,
      );
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          require.resolve("workerd/bin/workerd"),
          "test",
          "-I",
          dirname(dirname(require.resolve("workerd/package.json"))),
          join(directory, "config.capnp"),
          "budget-test",
        ],
        { timeout: 15_000 },
      );
      expect(stdout + stderr).toContain("BUDGET_WORKER_OK");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
