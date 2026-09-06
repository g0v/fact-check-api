import { convertIPv4ToBinary, convertIPv6ToBinary } from "hono/utils/ipaddr";
import { LIMITS } from "../config";
import { ApiError } from "./errors";
import { array, record, string } from "./validation";
import { readLimitedText, type Fetcher } from "./http";

const ipv4Blocked: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];
const ipv6Blocked: [string, number][] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

function inRange(ip: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return ip >> shift === base >> shift;
}

export function isPublicIp(address: string): boolean {
  try {
    if (address.includes(":")) {
      // URL parser 驗證並正規化 IPv6，包括 IPv4-mapped 表示法。
      const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
      const ip = convertIPv6ToBinary(host);
      return (
        inRange(ip, convertIPv6ToBinary("2000::"), 3, 128) &&
        !ipv6Blocked.some(([base, prefix]) => inRange(ip, convertIPv6ToBinary(base), prefix, 128))
      );
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
    const host = new URL(`http://${address}/`).hostname;
    if (host !== address) return false;
    const ip = convertIPv4ToBinary(host);
    return !ipv4Blocked.some(([base, prefix]) =>
      inRange(ip, convertIPv4ToBinary(base), prefix, 32),
    );
  } catch {
    return false;
  }
}

export function validatePublicUrl(value: string): URL {
  const invalid = () =>
    new ApiError("INVALID_INPUT", "url 必須是公開 HTTP／HTTPS 網址，且不能含帳號密碼。", 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    value.length > LIMITS.url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw invalid();
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (!isPublicIp(host.replace(/^\[|\]$/g, ""))) throw invalid();
  } else if (
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|lan|home|invalid|test)$/.test(host)
  ) {
    throw invalid();
  }
  url.hostname = host;
  url.hash = "";
  return url;
}

// 僅作來源連結正規化，不會抓取。來源中的不合法連結不進入 API 回應。
export function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return validatePublicUrl(value).href;
  } catch {
    return undefined;
  }
}

export async function assertPublicDns(
  url: URL,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<void> {
  if (url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return;
  const responses = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const endpoint = new URL("https://cloudflare-dns.com/dns-query");
      endpoint.searchParams.set("name", url.hostname);
      endpoint.searchParams.set("type", type);
      const response = await fetcher(endpoint, {
        headers: { Accept: "application/dns-json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("無法確認網址的 DNS 位址。");
      }
      const data = record(JSON.parse(await readLimitedText(response.body, 32_000, signal)));
      if (data.Status !== 0) throw new Error("網址 DNS 查詢失敗。");
      return data.Answer === undefined ? [] : array(data.Answer).map(record);
    }),
  );
  const addresses = responses
    .flat()
    .filter((answer) => answer.type === 1 || answer.type === 28)
    .map((answer) => string(answer.data, 100));
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw new Error("網址解析到非公開位址，已停止抓取。");
  }
}
