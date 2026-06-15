// 순수 DOM 빌더. 상태 변경 없음 — controller 가 이벤트를 소유한다.
// Tailwind CSS + DaisyUI 클래스를 적극 활용. Font Awesome 아이콘으로 토큰/보너스 표현.
import type { BallColor, CardDef, Color } from "@/game/types";
import { COLORS, stageOf } from "@/game/types";
import { ROMAN } from "@/data/cards";
import { cardImg, ballImg } from "./assets";

/** romanized → 한글 이름 역조회 (evolvesTo 표시용). */
const ROMAN_TO_KR: Record<string, string> = {};
for (const [kr, rom] of Object.entries(ROMAN)) ROMAN_TO_KR[rom] = kr;

/** 카드의 첫 번째 보너스 색상(카드 배경색 결정용). */
function cardBonusColor(card: CardDef): Color | undefined {
  return COLORS.find((c) => (card.bonus[c] ?? 0) > 0);
}

// ── Helpers ──────────────────────────────────────────────────────────

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, class: cls, style, ...rest } = props;
  if (typeof style === "string") node.setAttribute("style", style);
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== null) {
      (node as Record<string, unknown>)[k] = v;
    }
  }
  if (dataset && typeof dataset === "object") for (const [k, v] of Object.entries(dataset as Record<string, string>)) node.dataset[k] = v;
  if (typeof cls === "string") node.className = cls;
  node.append(...children);
  return node;
}

// ── Color → FA icon mapping ──────────────────────────────────────────

const COLOR_FA: Record<Color, string> = {
  red: "fa-fire",
  blue: "fa-droplet",
  black: "fa-moon",
  pink: "fa-heart",
  yellow: "fa-bolt",
};

const COLOR_CLASS: Record<Color, string> = {
  red: "red", blue: "blue", black: "black", pink: "pink", yellow: "yellow",
};

// ── Ball icon ────────────────────────────────────────────────────────

const BALL_ROMAN: Record<BallColor, string> = {
  red: "monsterball", blue: "superball", black: "hyperball",
  pink: "healball", yellow: "quickball", gold: "masterball",
};

const COLOR_LABEL: Record<BallColor, string> = {
  red: "빨강", blue: "파랑", black: "검정", pink: "분홍", yellow: "노랑", gold: "마스터볼",
};

/** 볼 색 → 작은 아이콘. 이미지 우선. */
export function ballIcon(color: BallColor, size = 16): HTMLElement {
  const src = ballImg(BALL_ROMAN[color]);
  if (src) {
    return el("img", { src, alt: COLOR_LABEL[color], width: size, height: size, class: "inline-block" });
  }
  const fa = color === "gold" ? "fa-star" : COLOR_FA[color as Color] ?? "fa-circle";
  return el("i", { class: `fa-solid ${fa}` });
}

// ── Ball chip (DaisyUI badge style) ──────────────────────────────────

/** 컬러 볼 칩: 배경색 + FA 아이콘 + 수량. */
export function ballChip(color: BallColor, count: number): HTMLElement {
  const cls = ["ball-chip"];
  if (color === "gold") cls.push("gold");
  else cls.push(COLOR_CLASS[color as Color] ?? "");
  const fa = color === "gold" ? "fa-star" : COLOR_FA[color as Color] ?? "fa-circle";
  return el("span", { class: cls.join(" "), title: COLOR_LABEL[color] }, [
    el("i", { class: `fa-solid ${fa} text-xs` }),
    `${COLOR_LABEL[color]} ${count}`,
  ]);
}

// ── Bonus chip (FA icon + count, circular) ───────────────────────────

/** 컬러별 보너스 표시(원형 배지). */
export function bonusBadge(c: Color, n: number): HTMLElement {
  const fa = COLOR_FA[c];
  return el("span", { class: `bonus-chip ${COLOR_CLASS[c]}`, title: `${COLOR_LABEL[c]} 보너스 ${n}` }, [
    el("i", { class: `fa-solid ${fa}` }),
  ]);
}

// ── Cost pip (FA icon + count, small) ────────────────────────────────

/** 카드 비용 pip 들(원가). */
export function costPips(card: CardDef): HTMLElement {
  const wrap = el("div", { class: "card-cost" });
  for (const c of COLORS) {
    const n = card.cost[c];
    if (!n) continue;
    const fa = COLOR_FA[c];
    wrap.append(el("span", { class: `cost-pip ${COLOR_CLASS[c]}` }, [
      el("i", { class: `fa-solid ${fa}` }),
      String(n),
    ]));
  }
  return wrap;
}

// ── Card element (DaisyUI card style) ────────────────────────────────

export interface CardOpts {
  clickable?: boolean;
  affordable?: boolean;
  dim?: boolean;
  reserveBtn?: boolean;
  evoBtn?: { sourceId: string; targetName: string; pointsGain: number };
  onclick?: (ev: MouseEvent) => void;
  badge?: string;
}

/** 카드 요소: 상단 비용, 중앙 이미지+이름, 하단 보너스+점수. */
export function makeCardEl(card: CardDef, opts: CardOpts = {}): HTMLElement {
  const cls = ["poke-card"];
  if (opts.clickable) cls.push("clickable");
  if (opts.affordable) cls.push("affordable");
  if (opts.dim) cls.push("dim");
  // Add bonus color class for background tinting
  const bonusClr = cardBonusColor(card);
  if (bonusClr) cls.push(`card-bg-${COLOR_CLASS[bonusClr]}`);

  // Bonus display
  const bonusEl = el("div", { class: "card-bonus" });
  for (const c of COLORS) {
    const n = card.bonus[c] ?? 0;
    if (n > 0) {
      const fa = COLOR_FA[c];
      for (let i = 0; i < n; i++) {
        bonusEl.append(el("span", { class: `bonus-chip ${COLOR_CLASS[c]}` }, [
          el("i", { class: `fa-solid ${fa}` }),
        ]));
      }
    }
  }

  // Stage badge
  const stage = stageOf(card.tier);
  const stageText = stage > 0 ? `${stage}단계` : card.tier === "rare" ? "희귀" : "전설";

  const body = el("div", { class: "card-body" }, [
    el("div", { class: "flex items-center justify-between" }, [
      el("span", { class: "card-name" }, [card.name]),
      card.points ? el("span", { class: "card-pts" }, [`${card.points}P`]) : "",
    ]),
    costPips(card),
    bonusEl,
    el("div", { class: "text-[8px] opacity-40 mt-0.5" }, [stageText]),
  ]);

  const node = el("div", { class: cls.join(" "), dataset: { id: card.id } }, [
    el("img", { src: cardImg(card.tier, card.romanized), alt: card.name, class: "card-img" }),
    body,
  ]);

  if (opts.badge) node.append(el("span", { class: "badge badge-sm badge-primary absolute top-1 left-1" }, [opts.badge]));

  if (opts.reserveBtn) {
    const btn = el("button", { class: "reserve-btn", title: "보관" }, [
      el("i", { class: "fa-solid fa-bookmark" }),
    ]);
    btn.addEventListener("click", (e) => { e.stopPropagation(); });
    node.append(btn);
  }

  if (opts.evoBtn) {
    const evo = opts.evoBtn;
    const btn = el("button", {
      class: "evo-btn",
      title: `진화 → ${evo.targetName} (+${evo.pointsGain}점)`,
      dataset: { sourceId: evo.sourceId },
    }, [`→${evo.pointsGain}P`]);
    btn.addEventListener("click", (e) => { e.stopPropagation(); });
    node.append(btn);
  }

  if (opts.onclick) node.addEventListener("click", opts.onclick);
  return node;
}

// ── MiniCard ──────────────────────────────────────────────────────────

export interface MiniCardOpts {
  size?: number;
  label?: boolean;
  affordable?: boolean;
  onclick?: (ev: MouseEvent) => void;
  reserveBtn?: boolean;
  evoBtn?: { sourceId: string; targetName: string; pointsGain: number };
}

/** 작은 카드 썸네일. */
export function makeMiniCard(card: CardDef, opts: MiniCardOpts = {}): HTMLElement {
  const cls = ["mini-card"];
  if (opts.affordable) cls.push("affordable");
  if (opts.onclick) cls.push("clickable");
  // Add bonus color class for background tinting (same as poke-card)
  const bonusClr = cardBonusColor(card);
  if (bonusClr) cls.push(`card-bg-${COLOR_CLASS[bonusClr]}`);

  const children: (Node | string)[] = [
    el("img", { src: cardImg(card.tier, card.romanized), alt: card.name }),
  ];
  if (opts.label) {
    children.push(el("div", { class: "mini-name" }, [card.name]));
  }

  const node = el("div", { class: cls.join(" "), dataset: { id: card.id } }, children);

  if (opts.onclick) node.addEventListener("click", opts.onclick);
  return node;
}

// ── Tooltip ──────────────────────────────────────────────────────────

let currentTooltip: HTMLElement | null = null;

function evoCostSummary(card: CardDef): string {
  if (!card.evoCost) return "";
  return Object.entries(card.evoCost)
    .filter(([, v]) => v && v > 0)
    .map(([k, v]) => `${COLOR_LABEL[k as Color]} ${v}`)
    .join(" ");
}

export function showTooltip(anchor: HTMLElement, card: CardDef): void {
  hideTooltip();
  const tip = el("div", { class: "card-tooltip" }, [
    el("img", { src: cardImg(card.tier, card.romanized), alt: card.name }),
    el("div", { class: "tt-name" }, [card.name]),
    card.points ? el("div", { class: "tt-pts" }, [`${card.points}점`]) : "",
    el("div", { class: "tt-cost" }, [
      "비용: ",
      ...Object.entries(card.cost)
        .filter(([, v]) => v && v > 0)
        .map(([k, v]) => `${COLOR_LABEL[k as Color]}${v}`)
        .join(" "),
    ]),
    card.evolvesTo ? el("div", { class: "tt-evo" }, [`진화→${ROMAN_TO_KR[card.evolvesTo] ?? card.evolvesTo} (${evoCostSummary(card)})`]) : "",
  ]);
  document.body.append(tip);
  currentTooltip = tip;

  const rect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top;
  if (left + tipRect.width > window.innerWidth) left = rect.left - tipRect.width - 8;
  if (top + tipRect.height > window.innerHeight) top = window.innerHeight - tipRect.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideTooltip(): void {
  if (currentTooltip) { currentTooltip.remove(); currentTooltip = null; }
}

// ── AI log ────────────────────────────────────────────────────────────

export function aiLogEl(): HTMLElement {
  return el("div", { class: "ai-log" });
}

// ── Toast / Modal helpers ────────────────────────────────────────────

let toastTimeout: ReturnType<typeof setTimeout> | null = null;

/** 중앙 토스트 알림 (진화/포획 등). */
export function showToast(text: string, icon = "fa-star", durationMs = 2500): void {
  const existing = document.querySelector(".toast-container");
  if (existing) existing.remove();
  if (toastTimeout) clearTimeout(toastTimeout);

  const toast = el("div", { class: "toast-container" }, [
    el("div", { class: "alert alert-success shadow-lg flex items-center gap-3 px-6 py-4" }, [
      el("i", { class: `fa-solid ${icon} text-2xl` }),
      el("span", { class: "font-bold text-lg" }, [text]),
    ]),
  ]);
  document.body.append(toast);
  toastTimeout = setTimeout(() => toast.remove(), durationMs);
}

/** 진화 성공 토스트. */
export function showEvolutionToast(pokemonName: string): void {
  showToast(`${pokemonName} 진화 성공!`, "fa-wand-magic-sparkles", 3000);
}

/** 전설 포획 토스트. */
export function showCaptureToast(pokemonName: string): void {
  showToast(`${pokemonName} 포획!`, "fa-trophy", 3000);
}
