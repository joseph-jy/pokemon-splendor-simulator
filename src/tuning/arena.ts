// 자기대국 아레나(AI_PLAN.md 1단계). 좌석마다 다른 가중치로 헤드리스 대국을 돌린다.
// UI 무의존 — game/strategy 에만 의존. 튜닝(scripts/tune.ts)과 검증 매치에서 사용.
import { createGame } from "@/game/state";
import { applyEvolution, applyMainAction, finishTurn, rankPlayers, winnerId } from "@/game/engine";
import {
  DEFAULT_BUDGET,
  chooseStrongTurn,
  type SearchBudget,
} from "@/strategy/policy";
import type { StrategyWeights } from "@/strategy/weights";
import { Rng } from "@/game/rng";

export interface MatchResult {
  /** 승자 좌석 인덱스. */
  winner: number;
  turns: number;
  /** 순위순 좌석 인덱스(rankPlayers). */
  ranks: number[];
}

/** 한 판: 좌석별 가중치로 종료까지 진행. 같은 seed → 같은 보드(공통 난수). */
export function playMatch(
  weightsBySeat: readonly StrategyWeights[],
  seed: number,
  budget: SearchBudget = DEFAULT_BUDGET,
  maxTurns = 400,
): MatchResult {
  const s = createGame(seed, weightsBySeat.length);
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
  let turns = 0;
  while (!s.ended && turns < maxTurns) {
    const w = weightsBySeat[s.currentPlayer]!;
    const pick = chooseStrongTurn(s, rng, w, budget);
    if (pick) {
      applyMainAction(s, pick.action);
      if (pick.evolution) applyEvolution(s, pick.evolution);
    }
    finishTurn(s);
    turns++;
  }
  return { winner: winnerId(s), turns, ranks: rankPlayers(s) };
}

export interface SeriesResult {
  games: number;
  wins: number;
  winRate: number;
  /** 인원수 기준선(1/numPlayers). 이보다 유의하게 높으면 후보가 강함. */
  baselineRate: number;
  /**
   * 평균 순위 점수 ∈ [0,1]: 1위=1, 꼴찌=0 균등 배분. 기준선 0.5.
   * 승패(0/1)보다 판당 정보량이 많아 튜닝 적합도로 분산이 작다.
   */
  rankScore: number;
}

/**
 * 후보 1명 vs 기준 (numPlayers-1)명 시리즈.
 * 좌석 로테이션: 블록(numPlayers판) 안에서 같은 보드 seed 를 공유해 분산을 줄인다.
 */
export function playSeries(
  candidate: StrategyWeights,
  baseline: StrategyWeights,
  games: number,
  numPlayers: number,
  seedBase: number,
  budget: SearchBudget = DEFAULT_BUDGET,
): SeriesResult {
  let wins = 0;
  let rankSum = 0;
  for (let g = 0; g < games; g++) {
    const seat = g % numPlayers;
    const block = Math.floor(g / numPlayers);
    const seed = (seedBase + block * 7919) >>> 0;
    const seats = Array.from({ length: numPlayers }, (_, i) =>
      i === seat ? candidate : baseline,
    );
    const r = playMatch(seats, seed, budget);
    if (r.winner === seat) wins++;
    rankSum += (numPlayers - 1 - r.ranks.indexOf(seat)) / (numPlayers - 1);
  }
  return {
    games,
    wins,
    winRate: wins / games,
    baselineRate: 1 / numPlayers,
    rankScore: rankSum / games,
  };
}

/** 승률의 95% 신뢰구간 반폭(정규 근사). */
export function ci95(winRate: number, games: number): number {
  return 1.96 * Math.sqrt((winRate * (1 - winRate)) / games);
}
