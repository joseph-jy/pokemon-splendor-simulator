// 에셋 PNG → 인라인 데이터 URL 매핑. Vite 가 import 시 assetsInlineLimit=MAX 로 base64 인라인.
// 단일 HTML 빌드에서 모든 이미지가 HTML 내장된다.
import type { Tier } from "@/game/types";

const modules = import.meta.glob("/assets/**/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** "stage1/charmander" 형태 키 → URL. */
const byKey: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
  // "/assets/stage1/charmander.png" -> "stage1/charmander"
  const m = path.replace(/^\/assets\//, "").replace(/\.png$/, "");
  byKey[m] = url;
}

function dirOf(tier: Tier): string {
  if (tier === 1) return "stage1";
  if (tier === 2) return "stage2";
  if (tier === 3) return "stage3";
  return "rare"; // 희귀·전설 모두 rare/
}

/** 포켓몬 카드 이미지 URL. */
export function cardImg(tier: Tier, romanized: string): string {
  return byKey[`${dirOf(tier)}/${romanized}`] ?? "";
}

/** 볼 이미지 URL. */
export function ballImg(romanized: string): string {
  return byKey[`balls/${romanized}`] ?? "";
}

export const HAS_ASSETS = Object.keys(byKey).length > 0;
