// 카드 도감(docs/cardex.html) 생성기.
// 실행: npm run docs:cardex  (= npx vite-node scripts/gen-cardex.ts)
// src/data/cards.ts 가 단일 소스 — 카드 데이터가 바뀌면 이 스크립트를 다시 돌려 문서를 갱신한다.
// 이미지는 base64 인라인 대신 ../assets/ 상대경로 참조(에셋 8MB → 문서는 수십 KB 유지).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CARDS, ROMAN } from "@/data/cards";
import { COLORS, type CardDef, type Color, type Tier } from "@/game/types";
import { COLOR_DISPLAY } from "@/data/balls";

const OUT = resolve(import.meta.dirname ?? ".", "../docs/cardex.html");

/** romanized → 한글 이름 역조회(진화 대상 표시용). */
const ROMAN_TO_KR: Record<string, string> = {};
for (const [kr, rom] of Object.entries(ROMAN)) ROMAN_TO_KR[rom] = kr;

function dirOf(tier: Tier): string {
  return tier === 1 ? "stage1" : tier === 2 ? "stage2" : tier === 3 ? "stage3" : "rare";
}

function bonusColorOf(card: CardDef): Color {
  return COLORS.find((c) => (card.bonus[c] ?? 0) > 0)!;
}

// ── 진화 라인 재구성 ───────────────────────────────────────────────────
// LINES 는 비공개이므로 evolvesTo 사슬을 타고 라인을 복원한다. 라인 키 = 3단계 romanized.
const stage2ByRoman: Record<string, CardDef> = {};
for (const c of CARDS) if (c.tier === 2) stage2ByRoman[c.romanized] ??= c;

function lineKeyOf(card: CardDef): string | null {
  if (card.tier === 3) return card.romanized;
  if (card.tier === 2) return card.evolvesTo ?? null;
  if (card.tier === 1) return stage2ByRoman[card.evolvesTo!]?.evolvesTo ?? null;
  return null; // 희귀·전설은 진화 라인 없음
}

interface LineInfo {
  key: string;
  label: string;
  color: Color;
  order: number;
}
const lines: Record<string, LineInfo> = {};
for (const card of CARDS) {
  const key = lineKeyOf(card);
  if (!key || lines[key]) continue;
  if (card.tier !== 1) continue; // 라인 순서는 1단계 등장 순서를 따른다
  const s2 = stage2ByRoman[card.evolvesTo!]!;
  lines[key] = {
    key,
    label: `${card.name} → ${s2.name} → ${ROMAN_TO_KR[key] ?? key}`,
    color: bonusColorOf(card),
    order: Object.keys(lines).length,
  };
}

// ── 직렬화 ─────────────────────────────────────────────────────────────
interface OutCard {
  id: string;
  name: string;
  tier: Tier;
  points: number;
  color: Color;
  bonusN: number;
  img: string;
  cost: [Color, number][];
  master: boolean;
  line: string | null;
  evo: { name: string; img: string; color: Color; cost: [Color, number][] } | null;
}

const costList = (m: CardDef["cost"]): [Color, number][] =>
  COLORS.filter((c) => (m[c] ?? 0) > 0).map((c) => [c, m[c]!] as [Color, number]);

const cards: OutCard[] = CARDS.map((card) => {
  const evoTier: Tier | null = card.tier === 1 ? 2 : card.tier === 2 ? 3 : null;
  return {
    id: card.id,
    name: card.name,
    tier: card.tier,
    points: card.points,
    color: bonusColorOf(card),
    bonusN: card.bonus[bonusColorOf(card)]!,
    img: `../assets/${dirOf(card.tier)}/${card.romanized}.png`,
    cost: costList(card.cost),
    master: card.tier === "rare" || card.tier === "legendary",
    line: lineKeyOf(card),
    evo:
      evoTier && card.evolvesTo && card.evoCost
        ? {
            name: ROMAN_TO_KR[card.evolvesTo] ?? card.evolvesTo,
            img: `../assets/${dirOf(evoTier)}/${card.evolvesTo}.png`,
            color: COLORS.find((c) => (card.evoCost![c] ?? 0) > 0)!,
            cost: costList(card.evoCost),
          }
        : null,
  };
});

const BALL_IMG: Record<Color | "gold", string> = {
  red: "../assets/balls/monsterball.png",
  blue: "../assets/balls/superball.png",
  black: "../assets/balls/hyperball.png",
  pink: "../assets/balls/healball.png",
  yellow: "../assets/balls/quickball.png",
  gold: "../assets/balls/masterball.png",
};

const TIERS = [
  { key: "1", label: "1성", desc: "1단계 · 보너스 1 · 진화 가능" },
  { key: "2", label: "2성", desc: "2단계 · 보너스 1 · 진화 가능" },
  { key: "3", label: "3성", desc: "3단계 · 보너스 1 · 최종 진화" },
  { key: "rare", label: "희귀", desc: "보너스 2 · 마스터볼 1 필수 · 보관 불가" },
  { key: "legendary", label: "전설", desc: "보너스 2 · 2점 · 마스터볼 1 필수 · 보관 불가" },
];

const DATA = {
  cards,
  lines: Object.values(lines).sort((a, b) => a.order - b.order),
  ball: BALL_IMG,
  colorLabel: COLOR_DISPLAY,
  tiers: TIERS,
};

// ── HTML ───────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>포켓몬 스플렌더 카드 도감 — 전체 ${cards.length}장</title>
<style>
  :root {
    color-scheme: dark;
    /* 볼 색 토큰 — 게임 UI(src/ui/styles.css)와 동일 */
    --ball-red-rgb: 242, 44, 38;
    --ball-blue-rgb: 33, 132, 178;
    --ball-black-rgb: 46, 41, 40;
    --ball-pink-rgb: 235, 184, 210;
    --ball-yellow-rgb: 237, 232, 71;
    --ball-gold-rgb: 162, 93, 158;

    --page: #14151a;
    --surface: #1e1f26;
    --surface-2: #272932;
    --ink-1: #f2f3f7;
    --ink-2: #a9adbb;
    --ink-3: #7d8190;
    --border: rgba(255,255,255,0.12);
    --accent: #6aa9ff;
    --card-w: clamp(148px, 12.5vw, 186px);
  }
  html[data-theme="light"] {
    color-scheme: light;
    --page: #f4f4f1;
    --surface: #ffffff;
    --surface-2: #f0f0ec;
    --ink-1: #14151a;
    --ink-2: #55565e;
    --ink-3: #85868e;
    --border: rgba(0,0,0,0.12);
    --accent: #1f6fd0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
    background: var(--page); color: var(--ink-1);
    line-height: 1.6; font-size: 15px; -webkit-font-smoothing: antialiased;
  }
  main { max-width: 1440px; margin: 0 auto; padding: 0 20px 96px; }
  a { color: var(--accent); }

  /* ── 헤더 ─────────────────────────────────────── */
  header.hero { padding: 44px 0 20px; text-align: center; }
  .hero h1 { font-size: clamp(24px, 3.6vw, 34px); letter-spacing: -0.01em; }
  .hero p { color: var(--ink-2); margin-top: 8px; font-size: 15px; }
  .hero .total { color: var(--ink-1); font-weight: 700; }
  .theme-btn {
    position: absolute; top: 16px; right: 20px;
    background: var(--surface); color: var(--ink-2); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 14px; font-size: 13px; cursor: pointer;
    font-family: inherit;
  }
  .theme-btn:hover { color: var(--ink-1); }

  /* ── 컨트롤 바 ────────────────────────────────── */
  .controls {
    position: sticky; top: 0; z-index: 20;
    background: color-mix(in srgb, var(--page) 92%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
    padding: 12px 0;
    margin-bottom: 8px;
  }
  .ctrl-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ctrl-row + .ctrl-row { margin-top: 8px; }
  .ctrl-label {
    flex: 0 0 auto; width: 68px; font-size: 12.5px; color: var(--ink-3);
    letter-spacing: 0.02em;
  }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 13px; border-radius: 999px; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border);
    color: var(--ink-2); font-size: 13.5px; font-weight: 500;
    font-family: inherit; line-height: 1.4;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .chip:hover { color: var(--ink-1); border-color: var(--ink-3); }
  .chip[aria-pressed="true"] {
    background: var(--ink-1); color: var(--page); border-color: var(--ink-1); font-weight: 650;
  }
  .chip .dot {
    width: 12px; height: 12px; border-radius: 999px; display: inline-block;
    border: 1px solid rgba(128,128,128,0.45);
  }
  .chip .n { font-size: 11.5px; opacity: 0.65; font-variant-numeric: tabular-nums; }
  .dot.red { background: rgb(var(--ball-red-rgb)); }
  .dot.blue { background: rgb(var(--ball-blue-rgb)); }
  .dot.black { background: #3f434e; }
  .dot.pink { background: rgb(var(--ball-pink-rgb)); }
  .dot.yellow { background: rgb(var(--ball-yellow-rgb)); }

  .search {
    flex: 1 1 180px; max-width: 260px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 14px; color: var(--ink-1); font-size: 13.5px; font-family: inherit;
  }
  .search::placeholder { color: var(--ink-3); }
  .search:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .count { margin-left: auto; font-size: 13px; color: var(--ink-3); font-variant-numeric: tabular-nums; }

  /* ── 그룹 ─────────────────────────────────────── */
  .group { margin-top: 30px; }
  .group-head {
    display: flex; align-items: baseline; gap: 10px;
    padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 16px;
  }
  .group-head h2 { font-size: 18px; letter-spacing: -0.01em; }
  .group-head .swatch {
    width: 12px; height: 12px; border-radius: 3px; align-self: center;
    border: 1px solid rgba(128,128,128,0.45);
  }
  .group-head .meta { font-size: 12.5px; color: var(--ink-3); }
  .group-head .cnt { margin-left: auto; font-size: 12.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--card-w), 1fr));
    gap: 14px;
  }
  .empty { color: var(--ink-3); padding: 60px 0; text-align: center; font-size: 15px; }

  /* ── 카드 (게임 UI 의 .poke-card 재현) ─────────── */
  .pc {
    position: relative;
    display: flex; flex-direction: column;
    min-height: 250px;
    border-radius: 14px; overflow: hidden;
    --pc-accent: 235,184,210;
    background: linear-gradient(rgba(var(--pc-accent),0.3), rgba(var(--pc-accent),0.3)), #14151a;
    border: 3px solid rgb(var(--pc-accent));
    box-shadow: 0 2px 9px rgba(0,0,0,0.4);
    transition: transform 0.14s ease, box-shadow 0.14s ease;
  }
  .pc:hover { transform: translateY(-3px); box-shadow: 0 10px 26px rgba(0,0,0,0.5); }
  .pc.c-red { --pc-accent: var(--ball-red-rgb); }
  .pc.c-blue { --pc-accent: var(--ball-blue-rgb); }
  .pc.c-black { --pc-accent: 51, 54, 61; }
  .pc.c-pink { --pc-accent: var(--ball-pink-rgb); }
  .pc.c-yellow { --pc-accent: var(--ball-yellow-rgb); }
  .pc.t-rare { box-shadow: 0 0 0 2px rgba(255,255,255,0.28), 0 3px 13px rgba(0,0,0,0.5); }
  .pc.t-legendary { box-shadow: 0 0 0 3px rgba(255,255,255,0.4), 0 4px 18px rgba(0,0,0,0.55); }
  .pc.t-rare::after, .pc.t-legendary::after {
    content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 4;
    background: radial-gradient(120% 60% at 15% 0%, rgba(255,255,255,0.4), rgba(255,255,255,0) 55%);
    mix-blend-mode: screen;
  }

  .pc-head {
    position: relative; display: flex; align-items: center; justify-content: center;
    padding: 4px 8px; min-height: 74px;
    background: linear-gradient(180deg, rgba(var(--pc-accent),0.78), rgba(var(--pc-accent),0.4));
    border-bottom: 2px solid rgba(var(--pc-accent),0.8);
  }
  .pc-pts {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    font-size: 40px; font-weight: 900; line-height: 1; color: #fff;
    text-shadow: -2px -2px 0 rgb(var(--pc-accent)), 2px -2px 0 rgb(var(--pc-accent)),
                 -2px 2px 0 rgb(var(--pc-accent)), 2px 2px 0 rgb(var(--pc-accent)),
                 0 3px 5px rgba(0,0,0,0.3);
  }
  .pc-bonus { position: absolute; right: 8px; top: 8px; display: flex; gap: 3px; }
  .pc-bonus img { width: 40px; height: 40px; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35)); }

  .pc-evo {
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    padding: 2px 5px 3px; border-radius: 9px;
    background: linear-gradient(180deg, #6b7280, #4b5563);
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
  }
  .pc-evo.red { background: linear-gradient(180deg, #e85555, #c62222); }
  .pc-evo.blue { background: linear-gradient(180deg, #3f7ef2, #1c4fc0); }
  .pc-evo.black { background: linear-gradient(180deg, #4a4d57, #282a31); }
  .pc-evo.pink { background: linear-gradient(180deg, #ff77c8, #e23aa0); }
  .pc-evo.yellow { background: linear-gradient(180deg, #f2ce55, #d6a516); }
  .pc-evo img.evo-img {
    width: 38px; height: 44px; border-radius: 6px; object-fit: contain;
    background: #fff; border: 1.5px solid rgba(255,255,255,0.95);
  }
  .pc-evo .arr { color: #fff; font-size: 9px; line-height: 1; opacity: 0.95; }
  .pc-evo .evo-cost {
    display: flex; align-items: center; gap: 2px;
    font-size: 13px; font-weight: 900; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.55);
  }
  .pc-evo .evo-cost img { width: 14px; height: 14px; }
  .pc-evo-spacer { flex: 0 0 1px; }

  .pc-art {
    position: relative; flex: 1 1 auto; display: flex;
    align-items: center; justify-content: center; min-height: 0; overflow: hidden;
  }
  .pc-art img { width: 100%; height: 100%; min-height: 120px; object-fit: contain; }

  .pc-cost {
    position: absolute; left: 6px; bottom: 8px; z-index: 2;
    display: flex; flex-direction: column; gap: 4px;
  }
  .pc-chip {
    position: relative; width: 30px; height: 30px; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.4); border: 2px solid rgba(255,255,255,0.9);
  }
  .pc-chip span { font-size: 15px; font-weight: 900; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.55); }
  .pc-chip img { position: absolute; right: -5px; bottom: -4px; width: 15px; height: 15px; }
  .pc-chip.red { background: rgb(var(--ball-red-rgb)); }
  .pc-chip.blue { background: rgb(var(--ball-blue-rgb)); }
  .pc-chip.black { background: #33363d; }
  .pc-chip.pink { background: #e0559a; }
  .pc-chip.yellow { background: #e0a91e; }
  .pc-chip.gold { background: #8b5cf6; }

  .pc-name {
    position: absolute; right: 6px; bottom: 8px; z-index: 3;
    max-width: calc(100% - 46px); padding: 3px 10px; text-align: center;
    font-size: 12px; font-weight: 800; color: #2b2b33;
    background: rgba(255,255,255,0.94); border: 2px solid rgb(var(--pc-accent));
    border-radius: 999px;
  }

  /* ── 범례 ─────────────────────────────────────── */
  .legend { margin-top: 56px; border-top: 1px solid var(--border); padding-top: 24px; }
  .legend h2 { font-size: 16px; margin-bottom: 12px; }
  .legend table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  .legend th, .legend td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  .legend th { color: var(--ink-3); font-weight: 600; font-size: 12.5px; }
  .legend td:first-child { font-weight: 650; white-space: nowrap; }
  .legend .scroll-x { overflow-x: auto; }
  .legend p { color: var(--ink-3); font-size: 13px; margin-top: 12px; }

  @media (max-width: 640px) {
    :root { --card-w: 142px; }
    .ctrl-label { width: 100%; }
    main { padding: 0 12px 64px; }
  }
</style>
</head>
<body>
<button class="theme-btn" id="theme-btn" type="button">라이트 모드</button>
<main>
  <header class="hero">
    <h1>포켓몬 스플렌더 카드 도감</h1>
    <p>전체 <span class="total">${cards.length}장</span> — 등급별 · 색깔별 · 진화 라인별로 골라 보기</p>
  </header>

  <div class="controls">
    <div class="ctrl-row">
      <span class="ctrl-label">묶어보기</span>
      <div class="chips" id="f-group"></div>
    </div>
    <div class="ctrl-row">
      <span class="ctrl-label">등급</span>
      <div class="chips" id="f-tier"></div>
    </div>
    <div class="ctrl-row">
      <span class="ctrl-label">보너스 색</span>
      <div class="chips" id="f-color"></div>
      <input class="search" id="f-search" type="search" placeholder="이름 검색 (예: 리자몽)" autocomplete="off">
      <span class="count" id="count"></span>
    </div>
  </div>

  <div id="out"></div>

  <section class="legend">
    <h2>보는 법</h2>
    <div class="scroll-x">
      <table>
        <thead><tr><th>카드 위치</th><th>의미</th></tr></thead>
        <tbody>
          <tr><td>왼쪽 위 큰 숫자</td><td>승점. 0점 카드는 숫자를 표시하지 않는다.</td></tr>
          <tr><td>오른쪽 위 볼</td><td>이 카드가 주는 <strong>보너스 색과 개수</strong>. 이후 카드 비용을 그 색만큼 할인한다.</td></tr>
          <tr><td>가운데 위 미니 카드</td><td>진화 대상과 <strong>진화에 필요한 보너스</strong>(볼이 아니라 보유 카드 보너스로 충족). 1·2단계만.</td></tr>
          <tr><td>왼쪽 아래 원형 칩</td><td>획득 <strong>원가</strong>(할인 전). 보라색 칩은 마스터볼 1개 필수를 뜻한다.</td></tr>
        </tbody>
      </table>
    </div>
    <h2 style="margin-top:24px">등급</h2>
    <div class="scroll-x">
      <table>
        <thead><tr><th>등급</th><th>장수</th><th>설명</th></tr></thead>
        <tbody id="legend-tier"></tbody>
      </table>
    </div>
    <p>데이터 출처: <code>src/data/cards.ts</code> · 규칙: <a href="../GAME.md">GAME.md</a> · AI 해설: <a href="ai-analysis.html">ai-analysis.html</a><br>
    이 페이지는 <code>npm run docs:cardex</code> 로 생성된다 — 직접 편집하지 말 것.</p>
  </section>
</main>

<script>
const DATA = ${JSON.stringify(DATA)};
const $ = (id) => document.getElementById(id);

const TIER_LABEL = Object.fromEntries(DATA.tiers.map((t) => [t.key, t.label]));
const TIER_ORDER = DATA.tiers.map((t) => t.key);
const COLOR_ORDER = ["red", "yellow", "blue", "pink", "black"];
const LINE_BY_KEY = Object.fromEntries(DATA.lines.map((l) => [l.key, l]));

const state = { group: "tier", tier: "all", color: "all", q: "" };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function img(src, cls, alt) {
  const n = document.createElement("img");
  n.src = src; n.loading = "lazy"; n.alt = alt || "";
  if (cls) n.className = cls;
  return n;
}

// ── 카드 렌더 ──────────────────────────────────────────
function cardEl(c) {
  const root = el("article", "pc c-" + c.color + " t-" + c.tier);
  root.title = c.name + " (" + c.id + ") · " + TIER_LABEL[c.tier] + " · " + c.points + "점 · "
    + DATA.colorLabel[c.color] + " 보너스 " + c.bonusN;

  const head = el("div", "pc-head");
  head.append(el("div", "pc-pts", c.points ? String(c.points) : ""));

  if (c.evo) {
    const evo = el("div", "pc-evo " + c.evo.color);
    evo.title = "진화 → " + c.evo.name;
    evo.append(img(c.evo.img, "evo-img", c.evo.name), el("span", "arr", "▼"));
    const cost = el("div", "evo-cost");
    for (const [col, n] of c.evo.cost) {
      cost.append(document.createTextNode(String(n)), img(DATA.ball[col], "", DATA.colorLabel[col]));
    }
    evo.append(cost);
    head.append(evo);
  } else {
    head.append(el("div", "pc-evo-spacer"));
  }

  const bonus = el("div", "pc-bonus");
  for (let i = 0; i < c.bonusN; i++) bonus.append(img(DATA.ball[c.color], "", DATA.colorLabel[c.color]));
  head.append(bonus);

  const art = el("div", "pc-art");
  art.append(img(c.img, "", c.name));

  const cost = el("div", "pc-cost");
  for (const [col, n] of c.cost) {
    const chip = el("div", "pc-chip " + col);
    chip.title = DATA.colorLabel[col] + " " + n;
    chip.append(el("span", "", String(n)), img(DATA.ball[col], "", ""));
    cost.append(chip);
  }
  if (c.master) {
    const chip = el("div", "pc-chip gold");
    chip.title = "마스터볼 1개 필수";
    chip.append(el("span", "", "1"), img(DATA.ball.gold, "", "마스터볼"));
    cost.append(chip);
  }

  root.append(head, art, cost, el("div", "pc-name", c.name));
  return root;
}

// ── 필터 · 그룹 ────────────────────────────────────────
function visible() {
  const q = state.q.trim();
  return DATA.cards.filter((c) =>
    (state.tier === "all" || String(c.tier) === state.tier) &&
    (state.color === "all" || c.color === state.color) &&
    (!q || c.name.includes(q) || c.id.includes(q)));
}

function groupsOf(list) {
  if (state.group === "none") return [{ title: null, cards: list }];
  if (state.group === "tier") {
    return TIER_ORDER
      .map((t) => {
        const meta = DATA.tiers.find((x) => x.key === t);
        return { title: meta.label, meta: meta.desc, cards: list.filter((c) => String(c.tier) === t) };
      })
      .filter((g) => g.cards.length);
  }
  if (state.group === "color") {
    return COLOR_ORDER
      .map((col) => ({
        title: DATA.colorLabel[col],
        swatch: col,
        meta: "보너스 색 " + DATA.colorLabel[col],
        cards: list.filter((c) => c.color === col),
      }))
      .filter((g) => g.cards.length);
  }
  // 진화 라인별 — 라인 없는 희귀·전설은 마지막에 따로 묶는다
  const out = DATA.lines
    .map((l) => ({
      title: l.label,
      swatch: l.color,
      meta: DATA.colorLabel[l.color] + " 라인",
      cards: list.filter((c) => c.line === l.key)
        .sort((a, b) => TIER_ORDER.indexOf(String(a.tier)) - TIER_ORDER.indexOf(String(b.tier))),
    }))
    .filter((g) => g.cards.length);
  const noLine = list.filter((c) => !c.line);
  if (noLine.length) out.push({ title: "진화 없음 (희귀 · 전설)", meta: "마스터볼 1 필수 · 보관 불가", cards: noLine });
  return out;
}

function render() {
  const list = visible();
  const out = $("out");
  out.textContent = "";

  $("count").textContent = list.length === DATA.cards.length
    ? DATA.cards.length + "장 전체"
    : list.length + " / " + DATA.cards.length + "장";

  if (!list.length) {
    out.append(el("p", "empty", "조건에 맞는 카드가 없습니다."));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of groupsOf(list)) {
    const sec = el("section", "group");
    if (g.title) {
      const head = el("div", "group-head");
      if (g.swatch) {
        const sw = el("span", "swatch");
        sw.style.background = "rgb(var(--ball-" + g.swatch + "-rgb))";
        head.append(sw);
      }
      head.append(el("h2", "", g.title));
      if (g.meta) head.append(el("span", "meta", g.meta));
      head.append(el("span", "cnt", g.cards.length + "장"));
      sec.append(head);
    }
    const grid = el("div", "grid");
    for (const c of g.cards) grid.append(cardEl(c));
    sec.append(grid);
    frag.append(sec);
  }
  out.append(frag);
}

// ── 컨트롤 구성 ────────────────────────────────────────
function chipBar(host, key, items) {
  for (const it of items) {
    const b = el("button", "chip");
    b.type = "button";
    b.dataset.v = it.v;
    if (it.dot) b.append(el("span", "dot " + it.dot));
    b.append(document.createTextNode(it.label));
    if (it.n != null) b.append(el("span", "n", String(it.n)));
    b.setAttribute("aria-pressed", String(state[key] === it.v));
    b.addEventListener("click", () => {
      state[key] = it.v;
      for (const s of host.children) s.setAttribute("aria-pressed", String(s.dataset.v === it.v));
      render();
    });
    host.append(b);
  }
}

const countBy = (fn, v) => DATA.cards.filter((c) => fn(c) === v).length;

chipBar($("f-group"), "group", [
  { v: "tier", label: "등급별" },
  { v: "color", label: "색깔별" },
  { v: "line", label: "진화 라인별" },
  { v: "none", label: "전체 한 눈에" },
]);

chipBar($("f-tier"), "tier", [
  { v: "all", label: "전체", n: DATA.cards.length },
  ...DATA.tiers.map((t) => ({ v: t.key, label: t.label, n: countBy((c) => String(c.tier), t.key) })),
]);

chipBar($("f-color"), "color", [
  { v: "all", label: "전체", n: DATA.cards.length },
  ...COLOR_ORDER.map((col) => ({
    v: col, label: DATA.colorLabel[col], dot: col, n: countBy((c) => c.color, col),
  })),
]);

$("f-search").addEventListener("input", (e) => { state.q = e.target.value; render(); });

for (const t of DATA.tiers) {
  const tr = document.createElement("tr");
  tr.append(el("td", "", t.label), el("td", "", countBy((c) => String(c.tier), t.key) + "장"), el("td", "", t.desc));
  $("legend-tier").append(tr);
}

// ── 테마 ───────────────────────────────────────────────
const themeBtn = $("theme-btn");
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === "dark" ? "라이트 모드" : "다크 모드";
  try { localStorage.setItem("cardex-theme", t); } catch (_) {}
}
setTheme((() => {
  try { return localStorage.getItem("cardex-theme") || "dark"; } catch (_) { return "dark"; }
})());
themeBtn.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

render();
</script>
</body>
</html>
`;

writeFileSync(OUT, html, "utf8");
console.log(`카드 도감 생성: ${OUT} (${cards.length}장, ${(html.length / 1024).toFixed(1)} KB)`);
