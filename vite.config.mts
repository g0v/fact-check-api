import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import * as vueCompiler from "@vue/compiler-sfc";

const isVitest = Boolean(process.env.VITEST);

export default defineConfig({
  publicDir: "public",
  plugins: [...(isVitest ? [] : [cloudflare()]), vue({ compiler: vueCompiler })],
  test: {
    passWithNoTests: true,
  },
  check: {
    fmt: true,
  },
});
