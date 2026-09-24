import { describe, expect, it } from "vite-plus/test";
import app from "../src/index";

describe("既有主程式整合", () => {
  it("health 與 hello 可正常使用", async () => {
    expect(await (await app.request("/health", {}, {})).json()).toEqual({ status: "ok" });
    expect(await (await app.request("/api/hello", {}, {})).text()).toBe("Hello World!");
  });
  it.each(["/", "/about"])("保留 Vue SSR 路由 %s", async (path) => {
    const response = await app.request(path, {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toMatch(/<!doctype html>/i);
  });
  it("掛載 /api/fact-check 的輸入驗證", async () => {
    expect((await app.request("/api/fact-check", {}, {})).status).toBe(400);
  });
});
