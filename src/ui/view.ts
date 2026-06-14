// 순수 DOM 빌더. 상태 변경 없음 — controller 가 이벤트를 소유한다.
import type { BallColor, CardDef, Color } from "@/game/types";
import { COLORS } from "@/game/types";
import { BALLS_BY_ID } from "@/data/balls";
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
  const img = el("img", { src: ballImg(def.romanized), alt: def.name, width: size, height: size });
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
}

/** 카드 요소. */
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
  if (opts.onclick) node.addEventListener("click", opts.onclick);
  return node;
}

/** 컬러별 보너스 표시(숫자 배지). */
export function bonusBadge(c: Color, n: number): HTMLElement {
  return el("span", { class: `b ${COLOR_CLASS[c]}`, title: `${c} 보너스 ${n}` }, [String(n)]);
}
