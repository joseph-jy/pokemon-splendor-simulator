// AI 의사결정 정책(STRATEGY.md). 3층: 팩트→평가함수→행동규칙.
// AI 모드 = argmax(결정론적 최선). 사용자 모드 = 상위-K 소프트선택(비결정론, MC 플레이아웃용).
import type { BallColor, CardDef, Color } from "@/game/types";
import { COLORS } from "@/game/types";
import type { GameState, PlayerState } from "@/game/state";
import { cardOf, discountedCost, playerPoints } from "@/game/state";
import type { Evolution, MainAction } from "@/game/actions";
import { legalEvolutions, legalMainActions } from "@/game/actions";
import type { Rng } from "@/game/rng";
import { WEIGHTS, USER_SOFTMAX_TEMP, USER_TOP_K } from "./weights";

/** 진화 테크 색상 집합(STRATEGY.md §1.2). 메인 3색 + 서브 집합. */
const TECH_SETS: readonly Color[][] = [
  ["blue", "yellow", "red"],
  ["yellow", "pink", "blue"],
  ["red", "black", "pink"],
  ["black", "blue", "yellow"],
  ["blue", "pink", "black"],
  ["yellow", "black", "red"],
  ["blue", "red"],
  ["yellow", "blue"],
  ["red", "pink"],
  ["pink", "black"],
  ["black", "yellow"],
];

function lineColorOf(card: CardDef): Color | undefined {
  return Object.keys(card.bonus)[0] as Color | undefined;
}

/** 카드가 현재 플레이어의 진화 경로상 다음 단계인지(source.evolvesTo === card.romanized). */
function isNextEvoStep(p: PlayerState, card: CardDef): boolean {
  return p.scored.some((sid) => cardOf(sid).evolvesTo === card.romanized);
}

/** 목표 색상 집합: 현재 보유·보드와 가장 정렬된 테크. 매 턴 재산출(적응). */
export function goalSet(state: GameState, p: PlayerState): Color[] {
  let best = TECH_SETS[0]!;
  let bestScore = -Infinity;
  for (const set of TECH_SETS) {
    let score = 0;
    const inset = (c: Color) => set.includes(c);
    for (const sid of p.scored) {
      const lc = lineColorOf(cardOf(sid));
      if (lc && inset(lc)) score += 2.5;
    }
    for (const rid of p.reserved) {
      const lc = lineColorOf(cardOf(rid));
      if (lc && inset(lc)) score += 1.5;
    }
    for (const c of COLORS) if (inset(c)) score += p.bonus[c] * 0.8;
    // 보드 기회: 골라인 카드가 공개되어 있으면 +
    for (const t of [1, 2, 3, "rare", "legendary"] as const) {
      for (const id of state.board[t]) {
        const lc = lineColorOf(cardOf(id));
        if (lc && inset(lc)) score += 0.4;
      }
    }
    if (score > bestScore) { bestScore = score; best = set; }
  }
  return best;
}

/** 볼 1개의 가치(목표 정렬 + 타겟 카드 비용 충족 기여). */
function ballValue(state: GameState, p: PlayerState, c: Color, goal: Color[]): number {
  let v = goal.includes(c) ? 0.55 : 0.04;
  for (const t of [2, 3] as const) {
    for (const id of state.board[t]) {
      const card = cardOf(id);
      const lc = lineColorOf(card);
      if (!lc || !goal.includes(lc)) continue;
      const need = Math.max(0, (card.cost[c] ?? 0) - p.bonus[c]);
      const short = Math.max(0, need - p.balls[c]);
      v += short * 0.12 * (card.points / 5);
    }
  }
  // 과다 보유 감가
  v *= 1 / (1 + p.balls[c] * 0.12);
  return v;
}

/** V_card(STRATEGY.md §2.1). */
export function cardValue(p: PlayerState, card: CardDef, goal: Color[]): number {
  let v = WEIGHTS.pts * card.points;
  for (const col of COLORS) {
    const n = card.bonus[col] ?? 0;
    if (n <= 0) continue;
    const marginal = goal.includes(col) ? 1.0 : 0.3;
    const diminishing = 1 / (1 + p.bonus[col] * 0.5);
    v += WEIGHTS.bonus * n * marginal * diminishing;
  }
  if (isNextEvoStep(p, card)) v += WEIGHTS.evo;
  const lc = lineColorOf(card);
  if (lc && goal.includes(lc)) v += WEIGHTS.goal;
  const cost = discountedCost(card, p.bonus);
  let costTotal = 0;
  for (const c of COLORS) costTotal += cost[c] ?? 0;
  const isNoble = card.tier === "rare" || card.tier === "legendary";
  if (isNoble) costTotal += 1; // 마스터볼 1개
  v -= WEIGHTS.cost * costTotal * 0.22;
  return v;
}

function gainsMaster(state: GameState, p: PlayerState): boolean {
  return state.supply.gold > 0 && p.balls.red + p.balls.blue + p.balls.black + p.balls.pink + p.balls.yellow + p.balls.gold < 10;
}

/** 행동 가치. */
export function actionValue(state: GameState, p: PlayerState, action: MainAction, goal: Color[]): number {
  switch (action.type) {
    case "acquire": {
      const card = cardOf(action.cardId);
      let v = cardValue(p, card, goal);
      v -= action.pay.gold * 0.12; // 마스터볼 사용 패널티
      return v;
    }
    case "reserve": {
      const card = cardOf(action.cardId);
      let v = cardValue(p, card, goal) * WEIGHTS.reserve;
      if (gainsMaster(state, p)) v += WEIGHTS.master;
      return v;
    }
    case "reserveBlind": {
      const tierVal = action.tier === 3 ? 1.0 : action.tier === 2 ? 0.7 : 0.4;
      let v = WEIGHTS.blind * tierVal;
      if (gainsMaster(state, p)) v += WEIGHTS.master;
      return v;
    }
    case "take3": {
      let v = 0;
      for (const c of action.colors) v += ballValue(state, p, c, goal);
      return v;
    }
    case "take2": {
      // 같은 색 2개: 효율 보너스
      return ballValue(state, p, action.color, goal) * 2 + 0.18;
    }
  }
}

/** V_evolve = 상위점수 − 하위점수 + tiebreak. */
function evolutionValue(source: CardDef, target: CardDef): number {
  return target.points - source.points + WEIGHTS.tiebreak;
}

/** 최적 진화(V_evolve 최대, 양수일 때만). */
export function bestEvolution(state: GameState): Evolution | null {
  const evos = legalEvolutions(state);
  if (evos.length === 0) return null;
  let best: Evolution | null = null;
  let bestV = 0;
  for (const e of evos) {
    const v = evolutionValue(cardOf(e.sourceId), cardOf(e.targetId));
    if (v > bestV) { bestV = v; best = e; }
  }
  return best;
}

function softmaxPick(scores: number[], rng: Rng): number {
  const top = scores
    .map((s, i) => ({ i, s }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(USER_TOP_K, scores.length));
  const mx = Math.max(...top.map((t) => t.s));
  const exps = top.map((t) => Math.exp((t.s - mx) / USER_SOFTMAX_TEMP));
  const sum = exps.reduce((a, b) => a + b, 0);
  let r = rng.next() * sum;
  for (let k = 0; k < top.length; k++) {
    r -= exps[k]!;
    if (r <= 0) return top[k]!.i;
  }
  return top[top.length - 1]!.i;
}

export type PolicyMode = "ai" | "user";

/** 한 턴의 행동+진화 선택. ai=argmax, user=소프트. */
export function chooseTurn(
  state: GameState,
  mode: PolicyMode,
  rng: Rng,
): { action: MainAction; evolution: Evolution | null } | null {
  const p = state.players[state.currentPlayer]!;
  const actions = legalMainActions(state);
  if (actions.length === 0) return null;
  const goal = goalSet(state, p);
  const scores = actions.map((a) => actionValue(state, p, a, goal));
  let idx: number;
  if (mode === "ai") {
    idx = scores.indexOf(Math.max(...scores));
  } else {
    idx = softmaxPick(scores, rng);
  }
  const action = actions[idx]!;
  const evolution = bestEvolution(state);
  return { action, evolution };
}

/** 편의: 현재 플레이어 점수. */
export { playerPoints };

export type { BallColor };
