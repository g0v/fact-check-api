import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import * as vueCompiler from "@vue/compiler-sfc";

const isVitest = Boolean(process.env.VITEST);

export default defineConfig(({ command }) => ({
  // 建置不讀取本機環境檔；secret 僅於開發執行期或部署環境注入。
  envDir: false,
  publicDir: "public",
  plugins: [
    ...(isVitest
      ? []
      : [
          cloudflare({
            config(config) {
              if (command === "build") config.configPath = undefined;
            },
          }),
        ]),
    vue({ compiler: vueCompiler }),
  ],
  test: {
    passWithNoTests: true,
  },
  check: {
    fmt: true,
  },
}));
