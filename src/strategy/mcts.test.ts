import { describe, it, expect } from "vitest";
import { createGame } from "@/game/state";
import { legalMainActions } from "@/game/actions";
import { Rng } from "@/game/rng";
import { CARDS } from "@/data/cards";
import { chooseMctsTurn, determinize } from "./mcts";
import type { CardDef } from "@/game/types";

// 테스트 속도용 축소 옵션.
const FAST = { iterations: 60, maxChildren: 8, maxDepth: 6, rolloutTurns: 30, c: 0.7 };

function findCard(pred: (c: CardDef) => boolean): CardDef {
  const c = CARDS.find(pred);
  if (!c) throw new Error("not found");
  return c;
}

describe("mcts", () => {
  it("determinize: 덱 구성은 유지하고 순서만 섞음", () => {
    const s = createGame(11, 4);
    const before = [...s.decks[1]];
    determinize(s, new Rng(5));
    expect([...s.decks[1]].sort()).toEqual([...before].sort());
    expect(s.decks[1].length).toBe(before.length);
  });

  it("합법 행동을 선택하고 원본 상태를 변경하지 않음", () => {
    const s = createGame(1234, 4);
    s.currentPlayer = 1;
    const supplyBefore = { ...s.supply };
    const deckBefore = [...s.decks[1]];
    const pick = chooseMctsTurn(s, new Rng(10), undefined, FAST);
    expect(pick).not.toBeNull();
    expect(legalMainActions(s)).toContainEqual(pick!.action);
    expect(s.supply).toEqual(supplyBefore);
    expect(s.decks[1]).toEqual(deckBefore);
    expect(s.currentPlayer).toBe(1);
  });

  it("동일 상태·동일 RNG 시드 → 동일 선택(재현성)", () => {
    const a = createGame(4321, 4);
    const b = createGame(4321, 4);
    const pa = chooseMctsTurn(a, new Rng(77), undefined, FAST);
    const pb = chooseMctsTurn(b, new Rng(77), undefined, FAST);
    expect(pa!.action).toEqual(pb!.action);
  });

  it("즉시 승리 가능한 획득을 선택", () => {
    const s = createGame(9, 4);
    s.currentPlayer = 0;
    const p = s.players[0]!;
    // 16점 상태 + 보너스로 무료가 된 고점수 카드 → 획득 시 18점 도달.
    const dragonite = findCard((c) => c.name === "망나뇽"); // 3점, pink7/blue3
    const scored3pts = CARDS.filter((c) => c.points >= 4 && c.tier !== "rare" && c.tier !== "legendary");
    p.scored = scored3pts.slice(0, 4).map((c) => c.id); // 16점 이상 확보
    p.bonus = { red: 0, blue: 7, black: 0, pink: 7, yellow: 0 };
    s.board[3] = [dragonite.id];
    const pick = chooseMctsTurn(s, new Rng(3), undefined, FAST);
    expect(pick!.action.type).toBe("acquire");
    expect((pick!.action as { cardId: string }).cardId).toBe(dragonite.id);
  });

  it("모든 플레이어가 막힌 교착 상태에서도 종료(스택 오버플로 회귀)", () => {
    // 볼 한도 10 + 보관 한도 + 지불 불가가 겹치면 아무도 행동할 수 없다.
    // 예전에는 walk() 의 강제 패스 경로가 깊이를 무시해 무한 재귀로 죽었다.
    const s = createGame(1, 2);
    s.decks[1] = []; s.decks[2] = []; s.decks[3] = [];
    s.decks.rare = []; s.decks.legendary = [];
    const charizard = findCard((c) => c.name === "리자몽"); // black7 / yellow3
    s.board[1] = []; s.board[2] = []; s.board[3] = [charizard.id];
    s.board.rare = []; s.board.legendary = [];
    // 둘 다 볼 10개 보유(더 못 집음) + 리자몽 지불 불가 → 루트만 "보관" 1수 가능.
    s.players[0]!.balls = { red: 0, blue: 0, black: 0, pink: 0, yellow: 10, gold: 0 };
    s.players[1]!.balls = { red: 0, blue: 0, black: 0, pink: 10, yellow: 0, gold: 0 };
    s.currentPlayer = 0;

    const pick = chooseMctsTurn(s, new Rng(1), undefined, { ...FAST, iterations: 12, maxDepth: 4 });
    expect(pick).not.toBeNull();
    expect(pick!.action.type).toBe("reserve");
  });

  it("루트 통계: 방문 수 내림차순 + 가치 범위", () => {
    const s = createGame(55, 4);
    const pick = chooseMctsTurn(s, new Rng(1), undefined, FAST);
    const stats = pick!.stats;
    expect(stats.length).toBeGreaterThan(0);
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i - 1]!.visits).toBeGreaterThanOrEqual(stats[i]!.visits);
    }
    for (const st of stats) {
      expect(st.value).toBeGreaterThanOrEqual(0);
      expect(st.value).toBeLessThanOrEqual(1);
    }
  });
});
