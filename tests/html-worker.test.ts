import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { decodeHTML } from "entities";
import { extractHtmlText } from "../src/api/services/url-context";

const require = createRequire(import.meta.url);

describe("Workers 原生 HTML extraction", () => {
  it("以真正 HTMLRewriter 移除 script／style，保留段落及 entity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fact-check-html-"));
    const html =
      "<html><head><style>不應出現的樣式</style></head><body><p>第一段 &amp; 測試</p><script>不應出現的腳本</script><template>不應出現的樣板</template><p>第二段<strong>文字</strong></p><!-- 不應出現的註解 --></body></html>";
    try {
      await writeFile(
        join(directory, "test.js"),
        `${extractHtmlText.toString()}
export default { async test() { console.log("HTML_RESULT=" + JSON.stringify(await extractHtmlText(${JSON.stringify(html)}))); } };`,
      );
      await writeFile(
        join(directory, "config.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "html-test", worker = (
  modules = [(name = "test.js", esModule = embed "test.js")], compatibilityDate = "2026-04-17"
))]);`,
      );
      // workerd test 直接執行 test handler，不開 HTTP socket，也不連線外部服務。
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          require.resolve("workerd/bin/workerd"),
          "test",
          "-I",
          dirname(dirname(require.resolve("workerd/package.json"))),
          join(directory, "config.capnp"),
        ],
        { timeout: 15_000 },
      );
      const match = /HTML_RESULT=("[^\n]*")/.exec(stdout + stderr);
      expect(match).not.toBeNull();
      const text = decodeHTML(JSON.parse(match![1])).replace(/\s+/g, " ").trim();
      expect(text).toBe("第一段 & 測試 第二段文字");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
