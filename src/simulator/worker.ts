// 시뮬레이션 Web Worker. 메인 스레드를 막지 않고 두 종류 요청을 처리한다(AGENTS.md).
// - winrate: Snapshot → 몬테카를로 승리 확률
// - aiturn: Snapshot → MCTS 로 AI 턴 선택(AI_PLAN.md 2단계)
import type { Snapshot } from "@/game/snapshot";
import { deserialize } from "@/game/snapshot";
import type { Evolution, MainAction } from "@/game/actions";
import { Rng } from "@/game/rng";
import { WEIGHTS } from "@/strategy/weights";
import { DEFAULT_MCTS, chooseMctsTurn } from "@/strategy/mcts";
import { simulateWinRates, type WinRates } from "./montecarlo";

/** 승리 확률 요청. kind 생략 시 winrate(하위 호환). */
export interface SimRequest {
  kind?: "winrate";
  requestId: number;
  snapshot: Snapshot;
  humanIndex: number;
  n: number;
  seed: number;
}

/** AI 턴 계산 요청. */
export interface AiTurnRequest {
  kind: "aiturn";
  requestId: number;
  snapshot: Snapshot;
  seed: number;
  iterations: number;
}

/** 치트 모드 추천 수 요청(?cheat=1): 사람 차례에 MCTS 루트 통계 상위 topN 반환. */
export interface HintRequest {
  kind: "hint";
  requestId: number;
  snapshot: Snapshot;
  seed: number;
  iterations: number;
  topN: number;
}

export type WorkerRequest = SimRequest | AiTurnRequest | HintRequest;

export interface SimResponse extends WinRates {
  kind: "winrate";
  requestId: number;
}

export interface AiTurnResponse {
  kind: "aiturn";
  requestId: number;
  pick: { action: MainAction; evolution: Evolution | null } | null;
}

export interface HintItem {
  action: MainAction;
  visits: number;
  /** 행동 주체 관점 평균 보상 ∈ [0,1]. */
  value: number;
}

export interface HintResponse {
  kind: "hint";
  requestId: number;
  hints: HintItem[];
}

export type WorkerResponse = SimResponse | AiTurnResponse | HintResponse;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  if (e.data.kind === "hint") {
    const { requestId, snapshot, seed, iterations, topN } = e.data;
    const state = deserialize(snapshot);
    const result = chooseMctsTurn(state, new Rng(seed), WEIGHTS, { ...DEFAULT_MCTS, iterations });
    const msg: HintResponse = {
      kind: "hint",
      requestId,
      hints: (result?.stats ?? []).slice(0, topN).map((s) => ({
        action: s.action,
        visits: s.visits,
        value: s.value,
      })),
    };
    ctx.postMessage(msg);
    return;
  }
  if (e.data.kind === "aiturn") {
    const { requestId, snapshot, seed, iterations } = e.data;
    const state = deserialize(snapshot);
    const result = chooseMctsTurn(state, new Rng(seed), WEIGHTS, { ...DEFAULT_MCTS, iterations });
    const msg: AiTurnResponse = {
      kind: "aiturn",
      requestId,
      pick: result ? { action: result.action, evolution: result.evolution } : null,
    };
    ctx.postMessage(msg);
    return;
  }
  const { requestId, snapshot, humanIndex, n, seed } = e.data;
  const state = deserialize(snapshot);
  const result = simulateWinRates(state, humanIndex, n, seed);
  const msg: SimResponse = { ...result, kind: "winrate", requestId };
  ctx.postMessage(msg);
};

export {};
