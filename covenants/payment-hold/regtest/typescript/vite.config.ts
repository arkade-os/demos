import { defineConfig } from "vite";
import { resolve } from "node:path";

// Browser traffic goes through this dev proxy so the pages work without CORS
// configuration on arkd / the emulator / esplora. SSE passes through untouched.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        merchant: resolve(import.meta.dirname, "merchant.html"),
        customer: resolve(import.meta.dirname, "customer.html"),
        playground: resolve(import.meta.dirname, "playground/index.html"),
      },
      // The compiler WASM package is loaded at runtime (local build or the
      // hosted playground) — never bundled.
      external: [/\/pkg\/arkade_compiler/],
    },
  },
  server: {
    proxy: {
      "/arkd": {
        target: "http://localhost:7070",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/arkd/, ""),
      },
      "/emulator": {
        target: "http://localhost:7073",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/emulator/, ""),
      },
      "/esplora": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/esplora/, ""),
      },
    },
  },
});
