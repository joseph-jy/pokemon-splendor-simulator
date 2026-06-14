// 순수 DOM 빌더. 상태 변경 없음 — controller 가 이벤트를 소유한다.
import type { BallColor, CardDef, Color } from "@/game/types";
import { COLORS } from "@/game/types";
import { BALLS_BY_ID, COLOR_DISPLAY } from "@/data/balls";
import { cardImg, ballImg } from "./assets";

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

const COLOR_CLASS: Record<Color, string> = {
  red: "red", blue: "blue", black: "black", pink: "pink", yellow: "yellow",
};

export function colorDot(c: Color): HTMLElement {
  return el("span", { class: `color-dot dot-${c}` });
}

/** 볼 색 → 작은 아이콘. */
export function ballIcon(color: BallColor, size = 16): HTMLImageElement {
  const def = BALLS_BY_ID[color];
  const img = el("img", { src: ballImg(def.romanized), alt: COLOR_DISPLAY[color], width: size, height: size });
  return img;
}

/** 카드 비용 pip 들(원가). */
export function costPips(card: CardDef): HTMLElement {
  const wrap = el("div", { class: "ccost" });
  for (const c of COLORS) {
    const n = card.cost[c];
    if (!n) continue;
    const pip = el("span", { class: `pip ${COLOR_CLASS[c]}` }, [ballIcon(c, 12), String(n)]);
    wrap.append(pip);
  }
  return wrap;
}

export interface CardOpts {
  onclick?: () => void;
  affordable?: boolean;
  clickable?: boolean;
  dim?: boolean;
  badge?: string;
  /** 보관 버튼 오버레이 표시 */
  reserveBtn?: boolean;
  /** 진화 오버레이 버튼 */
  evoBtn?: { sourceId: string; targetName: string; pointsGain: number };
}

/** 카드 요소. 크기는 CSS 가 제어한다. */
export function makeCardEl(card: CardDef, opts: CardOpts = {}): HTMLElement {
  const cls = ["card"];
  if (opts.clickable) cls.push("clickable");
  if (opts.affordable) cls.push("affordable");
  if (opts.dim) cls.push("dim");
  const node = el("div", { class: cls.join(" "), dataset: { id: card.id } }, [
    el("img", { src: cardImg(card.tier, card.romanized), alt: card.name }),
    el("div", { class: "meta" }, [
      el("div", { class: "cname" }, [
        `${card.name} `,
        card.points ? el("span", { class: "cpts" }, [`${card.points}점`]) : "",
      ]),
      costPips(card),
    ]),
  ]);
  if (opts.badge) node.append(el("span", { class: "badge" }, [opts.badge]));

  if (opts.reserveBtn) {
    const btn = el("button", { class: "reserve-btn", title: "보관" }, ["보관"]);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    node.append(btn);
    node.classList.add("has-reserve");
  }

  if (opts.evoBtn) {
    const evo = opts.evoBtn;
    const btn = el("button", {
      class: "evo-btn",
      title: `진화 → ${evo.targetName} (+${evo.pointsGain}점)`,
      dataset: { sourceId: evo.sourceId },
    }, [`→ ${evo.targetName}`]);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    node.append(btn);
    node.classList.add("has-evo");
  }

  if (opts.onclick) node.addEventListener("click", opts.onclick);
  return node;
}

// ── MiniCard ──────────────────────────────────────────────────────────

export interface MiniCardOpts {
  /** 이미지 크기 (px). 기본 48. */
  size?: number;
  /** 이름 라벨 표시. */
  label?: boolean;
  /** 구매 가능하면 초록 테두리. */
  affordable?: boolean;
  /** 클릭 핸들러. */
  onclick?: () => void;
  /** 보관 오버레이 버튼. */
  reserveBtn?: boolean;
  /** 진화 오버레이 버튼. */
  evoBtn?: { sourceId: string; targetName: string; pointsGain: number };
}

/** 작은 카드 썸네일 (하단 패널·AI 패널용). */
export function makeMiniCard(card: CardDef, opts: MiniCardOpts = {}): HTMLElement {
  const sz = opts.size ?? 48;
  const cls = ["mini-card"];
  if (opts.affordable) cls.push("affordable");
  if (opts.onclick) cls.push("clickable");

  const children: (Node | string)[] = [
    el("img", {
      src: cardImg(card.tier, card.romanized),
      alt: card.name,
      width: sz,
      height: sz,
    }),
  ];
  if (opts.label) {
    children.push(el("div", { class: "mini-name" }, [card.name]));
  }

  const node = el("div", { class: cls.join(" "), dataset: { id: card.id } }, children);

  if (opts.reserveBtn) {
    const btn = el("button", { class: "reserve-btn mini-reserve-btn", title: "보관" }, ["보관"]);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    node.append(btn);
  }

  if (opts.evoBtn) {
    const evo = opts.evoBtn;
    const btn = el("button", {
      class: "evo-btn mini-evo-btn",
      title: `진화 → ${evo.targetName} (+${evo.pointsGain}점)`,
      dataset: { sourceId: evo.sourceId },
    }, [`→${evo.pointsGain}점`]);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    node.append(btn);
  }

  if (opts.onclick) node.addEventListener("click", opts.onclick);
  return node;
}

// ── Tooltip ───────────────────────────────────────────────────────────

let currentTooltip: HTMLElement | null = null;

/** 진화 비용 요약 문자열 생성. */
function evoCostSummary(card: CardDef): string {
  if (!card.evoCost) return "";
  const parts: string[] = [];
  for (const c of COLORS) {
    const n = card.evoCost[c];
    if (n) parts.push(`${COLOR_DISPLAY[c]}${n}`);
  }
  return parts.join(" ");
}

/** 카드 툴팁 표시. anchor 근처에 고정 위치로 렌더링. */
export function showTooltip(anchor: HTMLElement, card: CardDef): void {
  hideTooltip();

  const children: (Node | string)[] = [
    el("img", {
      src: cardImg(card.tier, card.romanized),
      alt: card.name,
      class: "tooltip-img",
    }),
    el("div", { class: "tooltip-info" }, [
      el("div", { class: "tooltip-name" }, [
        card.name,
        card.points ? ` ${card.points}점` : "",
      ]),
      costPips(card),
    ]),
  ];

  // 진화 정보
  if (card.evolvesTo && card.evoCost) {
    const evoText = `→ ${card.evolvesTo} (${evoCostSummary(card)})`;
    children.push(el("div", { class: "tooltip-evo" }, [evoText]));
  }

  const tip = el("div", { class: "card-tooltip" }, children);

  // anchor 위치 기반 배치
  const rect = anchor.getBoundingClientRect();
  const tipLeft = rect.right + 8;
  const tipTop = rect.top;

  tip.style.position = "fixed";
  tip.style.left = `${Math.min(tipLeft, window.innerWidth - 200)}px`;
  tip.style.top = `${Math.min(tipTop, window.innerHeight - 200)}px`;
  tip.style.zIndex = "9999";

  document.body.append(tip);
  currentTooltip = tip;
}

/** 카드 툴팁 숨기기. */
export function hideTooltip(): void {
  if (currentTooltip) {
    currentTooltip.remove();
    currentTooltip = null;
  }
}

// ── AI 로그 ───────────────────────────────────────────────────────────

/** AI 액션 로그 표시용 작은 div. controller 가 내용을 채운다. */
export function aiLogEl(): HTMLElement {
  return el("div", { class: "ai-log" });
}

/** 컬러별 보너스 표시(숫자 배지). */
export function bonusBadge(c: Color, n: number): HTMLElement {
  return el("span", { class: `b ${COLOR_CLASS[c]}`, title: `${c} 보너스 ${n}` }, [String(n)]);
}
