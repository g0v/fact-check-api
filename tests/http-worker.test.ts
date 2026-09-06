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

describe("Workers 原生上游 HTTP 請求", () => {
  it("Safeguard 與 DNS 可送出請求，且不跟隨上游重新導向", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fact-check-http-"));
    try {
      const entry = join(directory, "entry.js");
      await writeFile(
        entry,
        `
import { moderate } from ${source("../src/api/services/moderation.ts")};
import { fetchJson } from ${source("../src/api/utils/http.ts")};
import { assertPublicDns } from ${source("../src/api/utils/url.ts")};

export default { async test() {
  const logs = [];
  const result = await moderate("測試主張", {
    OPENROUTER_API_KEY: "your-openrouter-api-key",
  }, fetch, (event) => logs.push(event));
  if (result.decision !== "allow") throw new Error("安全分類未成功。");
  if (!logs.some((event) => event.event === "moderation_http_response" && event.upstream_status === 200)) {
    throw new Error("未記錄成功的 HTTP 回應。");
  }
  if (JSON.stringify(logs).includes("your-openrouter-api-key")) throw new Error("紀錄含有金鑰。");
  await assertPublicDns(new URL("https://example.com"), fetch, new AbortController().signal);

  let rejectedHttpRedirect = false;
  try {
    await fetchJson(fetch, "https://redirect.example", {
      headers: { Authorization: "Bearer your-openrouter-api-key" },
    });
  } catch (error) { rejectedHttpRedirect = error.reason === "http_error"; }
  if (!rejectedHttpRedirect) throw new Error("HTTP 請求未拒絕重新導向。");

  let rejectedDnsRedirect = false;
  try {
    await assertPublicDns(new URL("https://redirect.example"), fetch, new AbortController().signal);
  } catch (error) { rejectedDnsRedirect = error.message === "無法確認網址的 DNS 位址。"; }
  if (!rejectedDnsRedirect) throw new Error("DNS 請求未拒絕重新導向。");
  console.log("HTTP_WORKER_OK");
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
      await writeFile(
        join(directory, "upstream.js"),
        `
export default { fetch(request) {
  const url = new URL(request.url);
  if (url.hostname === "openrouter.ai") {
    if (request.headers.get("Authorization") !== "Bearer your-openrouter-api-key") {
      throw new Error("安全分類未收到預期的授權標頭。");
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ decision: "allow", categories: [], reason: "測試成功。" }),
    } }] });
  }
  if (url.hostname === "redirect.example" || url.searchParams.get("name") === "redirect.example") {
    return Response.redirect("https://must-not-follow.example", 302);
  }
  // 若錯誤地跟隨重新導向，回有效資料，讓主測試辨識未拒絕重新導向的問題。
  if (url.hostname === "cloudflare-dns.com" || url.hostname === "must-not-follow.example") {
    return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.215.14" }] });
  }
  throw new Error("測試收到未預期的上游請求。");
} };
`,
      );
      // 全部 outbound 導向記憶體中的假上游；不開 socket、不連網、不使用真實 secret。
      await writeFile(
        join(directory, "config.capnp"),
        `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [
  (name = "http-test", worker = (
    modules = [(name = "test.js", esModule = embed "test.js")],
    compatibilityDate = "2026-04-17", globalOutbound = "upstream"
  )),
  (name = "upstream", worker = (
    modules = [(name = "upstream.js", esModule = embed "upstream.js")],
    compatibilityDate = "2026-04-17"
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
          "http-test",
        ],
        { timeout: 15_000 },
      );
      expect(stdout + stderr).toContain("HTTP_WORKER_OK");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
