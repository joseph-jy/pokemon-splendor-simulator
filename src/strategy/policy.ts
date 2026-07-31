// AI 의사결정 정책(STRATEGY.md). 3층: 팩트→평가함수→행동규칙.
// chooseTurn = MC 플레이아웃용 경량 정책. chooseStrongTurn = 실제 AI 턴용 후보 탐색 정책.
import type { BallColor, CardDef, Color } from "@/game/types";
import { COLORS, isNoble } from "@/game/types";
import type { GameState, PlayerState } from "@/game/state";
import {
  boardCardIds,
  cardOf,
  cloneGame,
  discountedCost,
  playerPoints,
} from "@/game/state";
import type { Evolution, MainAction } from "@/game/actions";
import { legalEvolutions, legalMainActions } from "@/game/actions";
import {
  WIN_THRESHOLD,
  applyEvolution,
  applyMainAction,
  finishTurn,
  rankPlayers,
  winnerId,
} from "@/game/engine";
import type { Rng } from "@/game/rng";
import { WEIGHTS, USER_SOFTMAX_TEMP, USER_TOP_K, type StrategyWeights } from "./weights";

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
function ballValue(state: GameState, p: PlayerState, c: Color, goal: Color[], w: StrategyWeights): number {
  let v = goal.includes(c) ? w.ballGoal : w.ballOff;
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
export function cardValue(p: PlayerState, card: CardDef, goal: Color[], w: StrategyWeights = WEIGHTS): number {
  let v = w.pts * card.points;
  for (const col of COLORS) {
    const n = card.bonus[col] ?? 0;
    if (n <= 0) continue;
    const marginal = goal.includes(col) ? 1.0 : 0.3;
    const diminishing = 1 / (1 + p.bonus[col] * 0.5);
    v += w.bonus * n * marginal * diminishing;
  }
  if (isNextEvoStep(p, card)) v += w.evo;
  const lc = lineColorOf(card);
  if (lc && goal.includes(lc)) v += w.goal;
  const cost = discountedCost(card, p.bonus);
  let costTotal = 0;
  for (const c of COLORS) costTotal += cost[c] ?? 0;
  const isNoble = card.tier === "rare" || card.tier === "legendary";
  if (isNoble) costTotal += 1; // 마스터볼 1개
  v -= w.cost * costTotal * w.costScale;
  return v;
}

function gainsMaster(state: GameState, p: PlayerState): boolean {
  return state.supply.gold > 0 && p.balls.red + p.balls.blue + p.balls.black + p.balls.pink + p.balls.yellow + p.balls.gold < 10;
}

/** 행동 가치. */
export function actionValue(
  state: GameState,
  p: PlayerState,
  action: MainAction,
  goal: Color[],
  w: StrategyWeights = WEIGHTS,
): number {
  switch (action.type) {
    case "acquire": {
      const card = cardOf(action.cardId);
      let v = cardValue(p, card, goal, w);
      v -= action.pay.gold * 0.12; // 마스터볼 사용 패널티
      return v;
    }
    case "reserve": {
      const card = cardOf(action.cardId);
      let v = cardValue(p, card, goal, w) * w.reserve;
      if (gainsMaster(state, p)) v += w.master;
      return v;
    }
    case "reserveBlind": {
      const tierVal = action.tier === 3 ? 1.0 : action.tier === 2 ? 0.7 : 0.4;
      let v = w.blind * tierVal;
      if (gainsMaster(state, p)) v += w.master;
      return v;
    }
    case "take3": {
      let v = 0;
      for (const c of action.colors) v += ballValue(state, p, c, goal, w);
      return v;
    }
    case "take2": {
      // 같은 색 2개: 효율 보너스
      return ballValue(state, p, action.color, goal, w) * 2 + w.take2Bonus;
    }
  }
}

/** V_evolve = 상위점수 − 하위점수 + tiebreak. */
function evolutionValue(source: CardDef, target: CardDef, w: StrategyWeights): number {
  return target.points - source.points + w.tiebreak;
}

/** 최적 진화(V_evolve 최대, 양수일 때만). */
export function bestEvolution(state: GameState, w: StrategyWeights = WEIGHTS): Evolution | null {
  const evos = legalEvolutions(state);
  if (evos.length === 0) return null;
  let best: Evolution | null = null;
  let bestV = 0;
  for (const e of evos) {
    const v = evolutionValue(cardOf(e.sourceId), cardOf(e.targetId), w);
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
  w: StrategyWeights = WEIGHTS,
): { action: MainAction; evolution: Evolution | null } | null {
  const p = state.players[state.currentPlayer]!;
  const actions = legalMainActions(state);
  if (actions.length === 0) return null;
  const goal = goalSet(state, p);
  const scores = actions.map((a) => actionValue(state, p, a, goal, w));
  let idx: number;
  if (mode === "ai") {
    idx = scores.indexOf(Math.max(...scores));
  } else {
    idx = softmaxPick(scores, rng);
  }
  const action = actions[idx]!;
  const preview = cloneGame(state);
  applyMainAction(preview, action);
  const evolution = bestEvolution(preview, w);
  return { action, evolution };
}

function legalMainActionsForPlayer(state: GameState, playerIndex: number): MainAction[] {
  const oldCurrent = state.currentPlayer;
  const oldEvolved = state.evolvedThisTurn;
  state.currentPlayer = playerIndex;
  state.evolvedThisTurn = false;
  try {
    return legalMainActions(state);
  } finally {
    state.currentPlayer = oldCurrent;
    state.evolvedThisTurn = oldEvolved;
  }
}

/**
 * rollout 용 greedy 정책의 견제 반영 비율. `w.block` 에 곱해 쓴다.
 * 하드코딩 상수였던 0.25 를 당시 기본값 block=0.65 기준 비율로 환산한 값이라,
 * 가중치가 튜닝돼도 "탐색 정책보다 약하게 견제한다"는 관계가 유지된다.
 */
const GREEDY_BLOCK_RATIO = 0.25 / 0.65;

function cardPressure(player: PlayerState, card: CardDef, w: StrategyWeights): number {
  let v = card.points * 3;
  let rawNeed = 0;
  for (const c of COLORS) {
    const bonus = card.bonus[c] ?? 0;
    if (bonus > 0) {
      v += bonus * 1.3;
      rawNeed += Math.max(0, (card.cost[c] ?? 0) - player.bonus[c]);
    }
  }
  const cost = discountedCost(card, player.bonus);
  let missing = 0;
  for (const c of COLORS) missing += Math.max(0, (cost[c] ?? 0) - player.balls[c]);
  if (isNoble(card.tier) && player.balls.gold < 1) missing += 1;
  if (isNextEvoStep(player, card)) v += w.pressureEvo;
  return v - Math.max(0, missing) * w.pressureMissing - Math.max(0, rawNeed) * 0.08;
}

function playerEval(state: GameState, playerIndex: number, w: StrategyWeights): number {
  const player = state.players[playerIndex]!;
  let v = playerPoints(player) * w.evalPts + player.evolutions * 2.2 + player.scored.length * 0.18;
  for (const c of COLORS) v += player.bonus[c] * w.evalBonus + player.balls[c] * 0.16;
  v += player.balls.gold * 0.75;
  for (const id of player.reserved) v += cardPressure(player, cardOf(id), w) * 0.3;

  let tempo = 0;
  for (const action of legalMainActionsForPlayer(state, playerIndex)) {
    if (action.type === "acquire") {
      const card = cardOf(action.cardId);
      tempo = Math.max(tempo, cardPressure(player, card, w) + (card.points >= 3 ? 1.2 : 0));
    } else if (action.type === "reserve") {
      tempo = Math.max(tempo, cardPressure(player, cardOf(action.cardId), w) * 0.28);
    }
  }
  return v + tempo * w.evalTempo;
}

function stateEval(state: GameState, playerIndex: number, w: StrategyWeights): number {
  const player = state.players[playerIndex]!;
  const points = playerPoints(player);
  if (state.ended) {
    const rank = rankPlayers(state).indexOf(playerIndex);
    const won = winnerId(state) === playerIndex ? 1 : 0;
    return won * 20_000 - rank * 3_500 + points * 80 + player.evolutions * 25;
  }

  const mine = playerEval(state, playerIndex, w);
  let strongestOpponent = -Infinity;
  let bestOpponentPoints = 0;
  for (const opponent of state.players) {
    if (opponent.id === playerIndex) continue;
    strongestOpponent = Math.max(strongestOpponent, playerEval(state, opponent.id, w));
    bestOpponentPoints = Math.max(bestOpponentPoints, playerPoints(opponent));
  }

  const rank = rankPlayers(state).indexOf(playerIndex);
  let v = mine - strongestOpponent + (points - bestOpponentPoints) * w.ptDiff + (state.numPlayers - 1 - rank) * 1.4;
  if (points >= 15) v += (points - 14) * w.ptDiff;
  if (points >= WIN_THRESHOLD) v += 450;
  if (bestOpponentPoints >= WIN_THRESHOLD) v -= 520;
  return v;
}

/** 이 카드를 사기까지 부족한 볼 개수(마스터볼로 메운 뒤 남는 부족분). 0 = 지금 구매 가능. */
function ballShortfall(p: PlayerState, card: CardDef): number {
  const cost = discountedCost(card, p.bonus);
  let need = 0;
  for (const c of COLORS) need += Math.max(0, (cost[c] ?? 0) - p.balls[c]);
  if (isNoble(card.tier)) need += 1; // 희귀/전설: 마스터볼 1개 필수
  return Math.max(0, need - p.balls.gold);
}

/**
 * 견제 가치: 이 카드를 내가 가져가면 상대가 잃는 것(STRATEGY.md §4).
 * 기본은 "상대가 지금 당장 살 수 있는 카드"만 위협으로 본다.
 * `w.blockNear > 0` 이면 아직 못 사지만 볼 `blockNearWindow` 개 이내로 다가온
 * 카드까지 **선제 견제** 대상에 넣고, 부족분에 반비례해 가치를 깎는다.
 */
export function blockValue(
  state: GameState,
  playerIndex: number,
  action: MainAction,
  w: StrategyWeights = WEIGHTS,
): number {
  if (action.type !== "reserve" && action.type !== "acquire") return 0;
  if (!boardCardIds(state).includes(action.cardId)) return 0;

  const card = cardOf(action.cardId);
  let best = 0;
  for (const opponent of state.players) {
    if (opponent.id === playerIndex) continue;
    const shortfall = ballShortfall(opponent, card);
    if (shortfall > 0 && (w.blockNear <= 0 || shortfall > w.blockNearWindow)) continue;

    let v = card.points * w.blockPts + w.blockBase;
    if (isNextEvoStep(opponent, card)) v += w.blockEvo;
    if (isNoble(card.tier)) v += w.blockNoble;
    if (playerPoints(opponent) >= 12) v += card.points * w.blockLeader;
    if (shortfall > 0) v *= w.blockNear / shortfall;
    best = Math.max(best, v);
  }
  return best;
}

function applyCandidate(
  state: GameState,
  action: MainAction,
  w: StrategyWeights,
): { state: GameState; evolution: Evolution | null } {
  const preview = cloneGame(state);
  applyMainAction(preview, action);
  const evolution = bestEvolution(preview, w);
  if (evolution) applyEvolution(preview, evolution);
  return { state: preview, evolution };
}

function chooseGreedyTurn(state: GameState, w: StrategyWeights): { action: MainAction; evolution: Evolution | null } | null {
  const player = state.players[state.currentPlayer]!;
  const actions = legalMainActions(state);
  if (actions.length === 0) return null;

  const goal = goalSet(state, player);
  let bestAction = actions[0]!;
  let bestScore = -Infinity;
  for (const action of actions) {
    let score = actionValue(state, player, action, goal, w)
      + blockValue(state, state.currentPlayer, action, w) * w.block * GREEDY_BLOCK_RATIO;
    if (action.type === "acquire") {
      const card = cardOf(action.cardId);
      score += card.points * 0.9;
      if (isNextEvoStep(player, card)) score += 1.4;
      if (playerPoints(player) + card.points >= WIN_THRESHOLD) score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }

  const preview = applyCandidate(state, bestAction, w);
  return { action: bestAction, evolution: preview.evolution };
}

function rolloutGreedy(state: GameState, maxTurns: number, w: StrategyWeights): void {
  for (let turn = 0; turn < maxTurns && !state.ended; turn++) {
    const pick = chooseGreedyTurn(state, w);
    if (pick) {
      applyMainAction(state, pick.action);
      if (pick.evolution) applyEvolution(state, pick.evolution);
    }
    finishTurn(state);
  }
}

/** 탐색 예산(후보 수·rollout 깊이). 튜닝 시 축소해 속도를 벌 수 있다. */
export interface SearchBudget {
  candidates: number;
  rolloutTurns: number;
}

export const DEFAULT_BUDGET: SearchBudget = { candidates: 18, rolloutTurns: 14 };

/** 실제 AI 턴용 강화 정책: 상위 후보를 가상 적용한 뒤 짧은 greedy rollout 으로 비교한다. */
export function chooseStrongTurn(
  state: GameState,
  rng?: Rng,
  w: StrategyWeights = WEIGHTS,
  budget: SearchBudget = DEFAULT_BUDGET,
): { action: MainAction; evolution: Evolution | null } | null {
  const playerIndex = state.currentPlayer;
  const player = state.players[playerIndex]!;
  const actions = legalMainActions(state);
  if (actions.length === 0) return null;

  const goal = goalSet(state, player);
  const candidates = actions
    .map((action) => ({
      action,
      pre:
        actionValue(state, player, action, goal, w)
        + blockValue(state, playerIndex, action, w) * w.block
        + (action.type === "acquire" ? cardOf(action.cardId).points * 1.1 : 0),
    }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, Math.min(budget.candidates, actions.length));

  let bestAction = candidates[0]!.action;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const preview = applyCandidate(state, candidate.action, w);
    const beforeFinishEval = stateEval(preview.state, playerIndex, w);
    finishTurn(preview.state);
    rolloutGreedy(preview.state, budget.rolloutTurns, w);

    let score = candidate.pre + beforeFinishEval * 0.24 + stateEval(preview.state, playerIndex, w) * w.mixAfter;
    if (preview.state.ended && winnerId(preview.state) === playerIndex) score += 10_000;
    if (rng) score += rng.next() * 0.001;

    if (score > bestScore) {
      bestScore = score;
      bestAction = candidate.action;
    }
  }

  const preview = applyCandidate(state, bestAction, w);
  return { action: bestAction, evolution: preview.evolution };
}

/** 편의: 현재 플레이어 점수. */
export { playerPoints };

export type { BallColor };
