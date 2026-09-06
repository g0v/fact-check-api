import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LIMITS } from "../src/api/config";
import { fetchUrlContext } from "../src/api/services/url-context";
import { readLimitedText, withTimeout, type Fetcher } from "../src/api/utils/http";
import { isPublicIp, validatePublicUrl } from "../src/api/utils/url";

afterEach(() => vi.useRealTimers());

describe("URL SSRF 與資源限制", () => {
  it.each([
    "http://localhost",
    "http://localhost.",
    "http://a.localhost",
    "http://a.local",
    "http://metadata.google.internal",
    "http://127.0.0.1",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://0.0.0.0",
    "http://224.0.0.1",
    "http://[::1]",
    "http://[::]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:7f00:1]",
    "http://[2002:7f00:1::]",
    "http://[2001:db8::1]",
    "file:///tmp/test",
    "ftp://example.com",
    "https://name:password@example.com",
  ])("拒絕 %s", (url) => {
    expect(() => validatePublicUrl(url)).toThrow();
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "接受公開 IP %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
  it("正規化網域與 fragment", () => {
    expect(validatePublicUrl("HTTPS://Example.COM./path#section").href).toBe(
      "https://example.com/path",
    );
  });

  function urlFetcher(
    options: {
      address?: string;
      redirect?: string;
      contentType?: string;
      body?: string;
      length?: string;
      dnsFailure?: boolean;
      missingAddresses?: boolean;
    } = {},
  ) {
    return vi.fn<Fetcher>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") {
        if (options.dnsFailure) return new Response("錯誤", { status: 500 });
        return Response.json({
          Status: 0,
          Answer:
            options.missingAddresses || url.searchParams.get("type") === "AAAA"
              ? []
              : [{ type: 1, data: options.address ?? "93.184.215.14" }],
        });
      }
      if (options.redirect)
        return new Response(null, { status: 302, headers: { location: options.redirect } });
      return new Response(options.body ?? "公開測試內容", {
        headers: {
          "content-type": options.contentType ?? "text/plain",
          ...(options.length ? { "content-length": options.length } : {}),
        },
      });
    });
  }

  it.each([
    { address: "127.0.0.1" },
    { address: "192.168.1.2" },
    { address: "::1" },
    { dnsFailure: true },
    { missingAddresses: true },
  ])("DNS 未確認為公開位址時不抓取目標：%j", async (options) => {
    const fetcher = urlFetcher(options);
    await expect(fetchUrlContext("https://example.com", fetcher)).rejects.toMatchObject({
      stage: "url",
    });
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith("https://cloudflare-dns.com/")),
    ).toBe(true);
  });

  it("重新導向到私有 IP 時不發出第二次目標請求", async () => {
    const fetcher = urlFetcher({ redirect: "http://169.254.169.254/" });
    await expect(fetchUrlContext("https://example.com", fetcher)).rejects.toMatchObject({
      stage: "url",
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("169.254.169.254"))).toBe(false);
  });

  it("每次重新導向重新檢查 DNS，拒絕改指向私有位址的網域", async () => {
    const fetcher = vi.fn<Fetcher>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({
          Status: 0,
          Answer: [
            {
              type: 1,
              data: url.searchParams.get("name") === "example.com" ? "93.184.215.14" : "10.0.0.1",
            },
          ],
        });
      return new Response(null, {
        status: 301,
        headers: { location: "https://redirect.example.com/" },
      });
    });
    await expect(fetchUrlContext("https://example.com", fetcher)).rejects.toMatchObject({
      stage: "url",
    });
    expect(
      fetcher.mock.calls.some(([url]) => String(url).startsWith("https://redirect.example.com/")),
    ).toBe(false);
  });

  it.each([
    { redirect: "https://example.com" },
    { contentType: "application/octet-stream" },
    { contentType: "text/plain; charset=big5" },
    { body: "" },
    { length: String(LIMITS.urlBytes + 1) },
    { body: "x".repeat(LIMITS.urlBytes + 1) },
  ])("拒絕循環、非文字、未支援編碼、空白或過大回應", async (options) => {
    await expect(fetchUrlContext("https://example.com", urlFetcher(options))).rejects.toMatchObject(
      { stage: "url" },
    );
  });

  it("抓取後標為使用者提供，且不轉送授權資訊", async () => {
    const fetcher = urlFetcher();
    expect(await fetchUrlContext("https://example.com", fetcher)).toMatchObject({
      source: "provided-url",
      reliability: "user-provided",
      evidenceText: "公開測試內容",
    });
    const [, init] = fetcher.mock.calls.at(-1)!;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
  });

  it("串流超過限制時取消讀取", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      cancel,
    });
    await expect(readLimitedText(stream, 50)).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });

  it("回應 body 停滯也受 timeout 限制", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const promise = withTimeout(
      (signal) => readLimitedText(new ReadableStream({ cancel }), 100, signal),
      50,
    );
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
});
