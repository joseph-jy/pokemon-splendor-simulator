import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

// 단일 HTML 산출: JS·CSS·이미지·Worker 모두 인라인.
// Worker 는 import.meta.url + new URL 방식 대신 `?worker&inline` 쿼리로 Blob URL 생성(별도 파일 없음).
export default defineConfig({
  plugins: [viteSingleFile({ inlinePattern: [], useRecommendedBuildConfig: true })],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  // 시뮬레이터 Web Worker: ES module 포맷, 빌드에 별도 chunk 로 분리되지 않도록 inline 처리는 호출측에서 ?worker&inline 사용.
  worker: { format: "es" },
  build: {
    target: "es2020",
    cssCodeSplit: false,
    outDir: "dist",
    // 모든 에셋을 인라인(base64). PNG 는 작아(≤334B) 기본 한도에서도 인라인되지만, 단일 파일 보장 위해 상향.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
