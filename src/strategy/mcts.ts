// ISMCTS 탐색(AI_PLAN.md 2단계). chooseStrongTurn 을 대체하는 강화 AI.
//
// 구조: 반복마다 ① 비공개 정보(덱 순서) 재셔플(determinization) ② UCT 선택 ③ 확장
// ④ 경량 정책(chooseTurn "ai") 롤아웃 ⑤ 순위점수 벡터 역전파(max^n — 각 노드는
// 행동한 플레이어 관점의 가치를 최대화).
//
// 근사(의도된 한계):
// - 상대의 비공개 보관(reserveBlind) 카드는 아는 것으로 취급(기존 몬테카를로와 동일 가정).
// - 진화는 행동 후 bestEvolution 휴리스틱으로 즉시 결정(분기 폭 제어).
import type { GameState } from "@/game/state";
import { cloneGame, playerPoints } from "@/game/state";
import { cardOf } from "@/game/state";
import type { Evolution, MainAction } from "@/game/actions";
import { legalMainActions } from "@/game/actions";
import {
  WIN_THRESHOLD,
  applyEvolution,
  applyMainAction,
  finishTurn,
  rankPlayers,
} from "@/game/engine";
import type { Tier } from "@/game/types";
import { Rng } from "@/game/rng";
import { WEIGHTS, type StrategyWeights } from "./weights";
import { actionValue, bestEvolution, chooseTurn, goalSet } from "./policy";

export interface MctsOptions {
  /** 시뮬레이션(플레이아웃) 횟수. 실력·시간과 비례. */
  iterations: number;
  /** 노드당 후보 행동 상한(휴리스틱 pre-score 상위 K). */
  maxChildren: number;
  /** 트리 깊이(턴 수) 상한 — 그 아래는 롤아웃. */
  maxDepth: number;
  /** 롤아웃 최대 턴. */
  rolloutTurns: number;
  /** UCT 탐험 상수. */
  c: number;
}

export const DEFAULT_MCTS: MctsOptions = {
  iterations: 400,
  maxChildren: 12,
  maxDepth: 8,
  rolloutTurns: 50,
  c: 0.7,
};

const ALL_TIERS: readonly Tier[] = [1, 2, 3, "rare", "legendary"];

interface Child {
  action: MainAction;
  n: number;
  /** 플레이어별 누적 보상. */
  q: number[];
  node: TreeNode;
}

interface TreeNode {
  children: Map<string, Child>;
}

function newNode(): TreeNode {
  return { children: new Map() };
}

/** 행동 식별 키. acquire 는 카드당 정규 지불 1개(computePay)라 cardId 로 충분. */
export function actionKey(a: MainAction): string {
  switch (a.type) {
    case "take3": return `t3:${[...a.colors].sort().join(",")}`;
    case "take2": return `t2:${a.color}`;
    case "reserve": return `rs:${a.cardId}`;
    case "reserveBlind": return `rb:${a.tier}`;
    case "acquire": return `aq:${a.cardId}`;
  }
}

/** 비공개 정보 재셔플: 모든 덱의 순서를 rng 로 다시 섞는다(가능 세계 샘플링). */
export function determinize(s: GameState, rng: Rng): void {
  for (const t of ALL_TIERS) rng.shuffle(s.decks[t]);
}

/** 종료(또는 컷오프) 상태의 플레이어별 보상 ∈ [0,1]. 순위점수 + 점수 진행도 소량. */
function rewards(s: GameState): number[] {
  const ranks = rankPlayers(s);
  const n = s.numPlayers;
  const out = new Array<number>(n).fill(0);
  for (const p of s.players) {
    const rankScore = n > 1 ? (n - 1 - ranks.indexOf(p.id)) / (n - 1) : 1;
    const progress = Math.min(playerPoints(p) / WIN_THRESHOLD, 1);
    out[p.id] = 0.85 * rankScore + 0.15 * progress;
  }
  return out;
}

/** 메인 액션 + 휴리스틱 진화 + 턴 종료. */
function applyTurn(s: GameState, action: MainAction, w: StrategyWeights): void {
  applyMainAction(s, action);
  const evo = bestEvolution(s, w);
  if (evo) applyEvolution(s, evo);
  finishTurn(s);
}

/** 후보 행동: pre-score 상위 K. (blockValue 는 비용이 커서 트리에서는 생략.) */
function candidateActions(
  s: GameState,
  w: StrategyWeights,
  maxChildren: number,
): { action: MainAction; key: string }[] {
  const actions = legalMainActions(s);
  if (actions.length === 0) return [];
  const p = s.players[s.currentPlayer]!;
  const goal = goalSet(s, p);
  return actions
    .map((action) => ({
      action,
      key: actionKey(action),
      pre:
        actionValue(s, p, action, goal, w)
        + (action.type === "acquire" ? cardOf(action.cardId).points * 1.1 : 0),
    }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, Math.min(maxChildren, actions.length));
}

/** 경량 정책 롤아웃 후 보상. */
function rollout(s: GameState, rng: Rng, w: StrategyWeights, maxTurns: number): number[] {
  for (let t = 0; t < maxTurns && !s.ended; t++) {
    const pick = chooseTurn(s, "ai", rng, w);
    if (pick) {
      applyMainAction(s, pick.action);
      if (pick.evolution) applyEvolution(s, pick.evolution);
    }
    finishTurn(s);
  }
  return rewards(s);
}

/** 선택→확장→롤아웃→역전파 1회. 보상 벡터를 반환. */
function walk(
  node: TreeNode,
  s: GameState,
  depth: number,
  rng: Rng,
  w: StrategyWeights,
  opts: MctsOptions,
): number[] {
  if (s.ended) return rewards(s);
  const acting = s.currentPlayer;
  const avail = candidateActions(s, w, opts.maxChildren);
  if (avail.length === 0) {
    // 합법 행동 없음(볼 한도 + 보관 한도 + 지불 불가가 겹칠 때): 강제 패스 후 계속.
    // 모든 플레이어가 동시에 막히면 게임이 진행되지 않으므로 반드시 깊이로 끊는다
    // (2·3인전은 은행이 자주 말라 실제로 발생 — 예전에는 스택 오버플로로 죽었다).
    finishTurn(s);
    if (depth + 1 >= opts.maxDepth) return rewards(s);
    return walk(node, s, depth + 1, rng, w, opts);
  }

  // 확장: 이 determinization 에서 아직 방문 안 한 후보가 있으면 최고 pre-score 부터.
  let chosen: Child | undefined;
  for (const cand of avail) {
    if (!node.children.has(cand.key)) {
      chosen = {
        action: cand.action,
        n: 0,
        q: new Array<number>(s.numPlayers).fill(0),
        node: newNode(),
      };
      node.children.set(cand.key, chosen);
      applyTurn(s, cand.action, w);
      const r = rollout(s, rng, w, opts.rolloutTurns);
      chosen.n += 1;
      for (let i = 0; i < r.length; i++) chosen.q[i]! += r[i]!;
      return r;
    }
  }

  // 선택: 이 determinization 에서 가능한 자식들만 대상으로 UCT(subset-armed).
  let totalN = 0;
  for (const cand of avail) totalN += node.children.get(cand.key)!.n;
  let bestScore = -Infinity;
  let bestCand = avail[0]!;
  for (const cand of avail) {
    const child = node.children.get(cand.key)!;
    const exploit = child.q[acting]! / child.n;
    const explore = opts.c * Math.sqrt(Math.log(totalN + 1) / child.n);
    const score = exploit + explore + rng.next() * 1e-6;
    if (score > bestScore) { bestScore = score; bestCand = cand; }
  }
  chosen = node.children.get(bestCand.key)!;
  applyTurn(s, bestCand.action, w);
  const r = depth + 1 >= opts.maxDepth
    ? rollout(s, rng, w, opts.rolloutTurns)
    : walk(chosen.node, s, depth + 1, rng, w, opts);
  chosen.n += 1;
  for (let i = 0; i < r.length; i++) chosen.q[i]! += r[i]!;
  return r;
}

/** MCTS 루트 통계(치트 모드·디버깅용). */
export interface MctsRootStat {
  action: MainAction;
  visits: number;
  /** 행동 주체(현재 플레이어) 관점 평균 보상 ∈ [0,1]. */
  value: number;
}

export interface MctsResult {
  action: MainAction;
  evolution: Evolution | null;
  /** 방문 수 내림차순 루트 자식 통계. */
  stats: MctsRootStat[];
}

/**
 * ISMCTS 로 현재 플레이어의 턴 선택. 원본 상태 불변.
 * 최다 방문(robust child) 행동을 고른다.
 */
export function chooseMctsTurn(
  state: GameState,
  rng: Rng,
  w: StrategyWeights = WEIGHTS,
  opts: MctsOptions = DEFAULT_MCTS,
): MctsResult | null {
  if (legalMainActions(state).length === 0) return null;
  const acting = state.currentPlayer;
  const root = newNode();

  for (let i = 0; i < opts.iterations; i++) {
    const s = cloneGame(state);
    determinize(s, rng);
    walk(root, s, 0, rng, w, opts);
  }

  const stats: MctsRootStat[] = [...root.children.values()]
    .map((c) => ({ action: c.action, visits: c.n, value: c.q[acting]! / c.n }))
    .sort((a, b) => b.visits - a.visits || b.value - a.value);
  if (stats.length === 0) return null;

  const action = stats[0]!.action;
  const preview = cloneGame(state);
  applyMainAction(preview, action);
  const evolution = bestEvolution(preview, w);
  return { action, evolution, stats };
}
