import { describe, it, expect } from "vitest";
import type { BallColor, CardDef, Color, Tier } from "@/game/types";
import {
  createGame, cloneGame, emptyBallMap, emptyColorMap,
  discountedCost, canAfford, playerPoints,
} from "@/game/state";
import { computePay, legalEvolutions, legalMainActions } from "@/game/actions";
import {
  applyEvolution, applyMainAction, finishTurn, rankPlayers, takeTurn, winnerId,
} from "@/game/engine";
import { CARDS } from "@/data/cards";
import { INITIAL_BALL_SUPPLY, REVEAL_PER_STAGE } from "@/data/balls";
import type { GameState, PlayerState } from "@/game/state";

function findCard(pred: (c: CardDef) => boolean): CardDef {
  const c = CARDS.find(pred);
  if (!c) throw new Error("card not found");
  return c;
}

/** 테스트용 최소 상태: 플레이어 0 에게 임의 balls/bonus/scored 설정. */
function soloState(opts: {
  balls?: Partial<Record<BallColor, number>>;
  bonus?: Partial<Record<Color, number>>;
  scored?: string[];
  reserved?: string[];
  board?: string[];
  supply?: Partial<Record<BallColor, number>>;
}): GameState {
  const s = createGame(1, 4);
  const p0 = s.players[0]!;
  p0.balls = { ...emptyBallMap(), ...opts.balls };
  p0.bonus = { ...emptyColorMap(), ...opts.bonus };
  p0.scored = opts.scored ?? [];
  p0.reserved = opts.reserved ?? [];
  if (opts.supply) s.supply = { ...INITIAL_BALL_SUPPLY, ...opts.supply };
  s.currentPlayer = 0;
  // 보드 단순화: 모든 tier 비우고 opts.board 만 stage1 에 배치
  for (const t of [1, 2, 3, "rare", "legendary"] as Tier[]) s.board[t] = [];
  if (opts.board) s.board[1] = [...opts.board];
  return s;
}

describe("setup", () => {
  it("초기 보드: 단계별 4장, 희귀·전설 1장", () => {
    const s = createGame(42);
    expect(s.board[1].length).toBe(REVEAL_PER_STAGE);
    expect(s.board[2].length).toBe(REVEAL_PER_STAGE);
    expect(s.board[3].length).toBe(REVEAL_PER_STAGE);
    expect(s.board.rare.length).toBe(1);
    expect(s.board.legendary.length).toBe(1);
  });

  it("초기 덱 잔량 = 전체 - 공개수", () => {
    const s = createGame(42);
    expect(s.decks[1].length).toBe(35 - REVEAL_PER_STAGE);
    expect(s.decks[2].length).toBe(30 - REVEAL_PER_STAGE);
    expect(s.decks[3].length).toBe(15 - REVEAL_PER_STAGE);
    expect(s.decks.rare.length).toBe(4);
    expect(s.decks.legendary.length).toBe(4);
  });

  it("공급량 = 7×5 + 5, 선공 인덱스 유효", () => {
    const s = createGame(7);
    expect(s.supply).toEqual(INITIAL_BALL_SUPPLY);
    expect(s.startingPlayer).toBe(s.currentPlayer);
    expect(s.currentPlayer).toBeGreaterThanOrEqual(0);
    expect(s.currentPlayer).toBeLessThan(4);
  });

  it("동일 시드 → 동일 상태(보드·덱 동일)", () => {
    const a = createGame(99);
    const b = createGame(99);
    expect(a.board).toEqual(b.board);
    expect(a.decks).toEqual(b.decks);
    expect(a.currentPlayer).toBe(b.currentPlayer);
  });

  it("cloneGame 은 독립(RNG·배열 분리)", () => {
    const a = createGame(5);
    const b = cloneGame(a);
    expect(b).not.toBe(a);
    expect(b.players[0]).not.toBe(a.players[0]);
    expect(b.decks[1]).not.toBe(a.decks[1]);
    a.players[0]!.balls.red = 3;
    expect(b.players[0]!.balls.red).toBe(0);
    b.rng.next();
    // a 의 rng 상태는 그대로
    const aBefore = a.rng.state;
    a.rng.next();
    expect(a.rng.state).not.toBe(aBefore);
  });
});

describe("cost & affordability", () => {
  it("discountedCost: 보너스만큼 차감, 0 미만 안 됨", () => {
    const card = findCard((c) => c.name === "파이리" && c.cost.blue === 4);
    const bonus = emptyColorMap();
    bonus.blue = 2;
    expect(discountedCost(card, bonus)).toEqual({ blue: 2 });
    bonus.blue = 10;
    expect(discountedCost(card, bonus)).toEqual({});
  });

  it("canAfford: 컬러 부족분을 마스터볼로 보충 가능", () => {
    const card = findCard((c) => c.name === "파이리" && c.cost.blue === 4);
    const p: PlayerState = {
      id: 0, isHuman: true, balls: { ...emptyBallMap(), blue: 2, gold: 2 },
      bonus: emptyColorMap(), reserved: [], scored: [], evolutions: 0,
    };
    expect(canAfford(p, card)).toBe(true);
    p.balls.gold = 1;
    expect(canAfford(p, card)).toBe(false);
  });

  it("희귀/전설 카드는 마스터볼 1개 추가 필요", () => {
    const noble = findCard((c) => c.tier === "rare"); // 라플라스: 비용 black3,blue2
    const cost = noble.cost;
    const p: PlayerState = {
      id: 0, isHuman: true,
      balls: { ...emptyBallMap(), black: cost.black!, blue: cost.blue! },
      bonus: emptyColorMap(), reserved: [], scored: [], evolutions: 0,
    };
    expect(canAfford(p, noble)).toBe(false); // 마스터볼 0
    p.balls.gold = 1;
    expect(canAfford(p, noble)).toBe(true);
  });

  it("computePay: 컬러 우선, 부족분 마스터볼, noble +1", () => {
    const noble = findCard((c) => c.tier === "rare");
    const p: PlayerState = {
      id: 0, isHuman: true,
      balls: { ...emptyBallMap(), black: 1, blue: 2, gold: 5 },
      bonus: emptyColorMap(), reserved: [], scored: [], evolutions: 0,
    };
    const pay = computePay(p, noble);
    expect(pay).not.toBeNull();
    // black3 → pay black1 + gold2; blue2 → pay blue2; noble +1 gold = gold3
    expect(pay!.black).toBe(1);
    expect(pay!.blue).toBe(2);
    expect(pay!.gold).toBe(3);
  });
});

describe("applyMainAction", () => {
  it("take3: 서로 다른 색 1개씩 획득, 공급 감소", () => {
    const s = soloState({});
    const before = { ...s.supply };
    applyMainAction(s, { type: "take3", colors: ["red", "blue", "black"] });
    const p = s.players[0]!;
    expect(p.balls.red).toBe(1);
    expect(p.balls.blue).toBe(1);
    expect(p.balls.black).toBe(1);
    expect(s.supply.red).toBe(before.red - 1);
    expect(s.supply.blue).toBe(before.blue - 1);
    expect(s.supply.black).toBe(before.black - 1);
  });

  it("take2: 같은 색 2개(공급 ≥4)", () => {
    const s = soloState({});
    applyMainAction(s, { type: "take2", color: "red" });
    expect(s.players[0]!.balls.red).toBe(2);
    expect(s.supply.red).toBe(INITIAL_BALL_SUPPLY.red - 2);
  });

  it("reserve: 보드 카드 보관 + 마스터볼 획득, 보드 보충", () => {
    const card = findCard((c) => c.tier === 1);
    const s = soloState({ board: [card.id] });
    // 보드 보충을 위해 덱에 카드 채우기
    s.decks[1] = CARDS.filter((c) => c.tier === 1 && c.id !== card.id).map((c) => c.id).slice(0, 10);
    applyMainAction(s, { type: "reserve", cardId: card.id });
    const p = s.players[0]!;
    expect(p.reserved).toContain(card.id);
    expect(p.balls.gold).toBe(1);
    expect(s.supply.gold).toBe(INITIAL_BALL_SUPPLY.gold - 1);
    expect(s.board[1]).not.toContain(card.id);
  });

  it("reserveBlind: 더미 탑 보관 + 마스터볼", () => {
    const top = findCard((c) => c.tier === 2);
    const s = soloState({});
    s.decks[2] = [top.id, "x"]; // top = pop() = 마지막
    s.decks[2] = ["x", top.id];
    applyMainAction(s, { type: "reserveBlind", tier: 2 });
    expect(s.players[0]!.reserved).toContain(top.id);
    expect(s.players[0]!.balls.gold).toBe(1);
  });

  it("acquire: 비용 지불 + 보너스 누적 + 점수 + 보드 제거", () => {
    const card = findCard((c) => c.name === "파이리" && c.cost.black === 3); // black3,pink2
    const s = soloState({
      balls: { black: 3, pink: 2 }, board: [card.id],
    });
    s.decks[1] = [];
    applyMainAction(s, {
      type: "acquire", cardId: card.id,
      pay: { red: 0, blue: 0, black: 3, pink: 2, yellow: 0, gold: 0 },
    });
    const p = s.players[0]!;
    expect(p.balls.black).toBe(0);
    expect(p.balls.pink).toBe(0);
    expect(p.bonus.blue).toBe(1); // 파이리 보너스 블루
    expect(playerPoints(p)).toBe(1);
    expect(s.board[1]).not.toContain(card.id);
  });
});

describe("evolution", () => {
  it("evoCost 미충족 시 진화 불가", () => {
    const charmander = findCard((c) => c.name === "파이리");
    const charmeleon = findCard((c) => c.name === "리자드");
    const s = soloState({
      scored: [charmander.id], board: [charmeleon.id], bonus: { yellow: 2 }, // need yellow3
    });
    expect(legalEvolutions(s)).toHaveLength(0);
  });

  it("진화: source 제거·target 추가, 보너스 불변, 점수 증분, 진화수+1", () => {
    const charmander = findCard((c) => c.name === "파이리");
    const charmeleon = findCard((c) => c.name === "리자드");
    const s = soloState({
      scored: [charmander.id], board: [charmeleon.id], bonus: { yellow: 3 },
    });
    const p = s.players[0]!;
    const bonusBefore = { ...p.bonus };
    applyEvolution(s, { sourceId: charmander.id, targetId: charmeleon.id });
    expect(p.scored).not.toContain(charmander.id);
    expect(p.scored).toContain(charmeleon.id);
    expect(p.bonus).toEqual(bonusBefore); // 진화 시 보너스 불변
    expect(playerPoints(p)).toBe(3); // 파이리1 → 리자드3
    expect(p.evolutions).toBe(1);
    expect(s.evolvedThisTurn).toBe(true);
  });

  it("진화는 턴당 1회", () => {
    const charmander = findCard((c) => c.name === "파이리");
    const charmeleon = findCard((c) => c.name === "리자드");
    const s = soloState({
      scored: [charmander.id], board: [charmeleon.id], bonus: { yellow: 3 },
    });
    applyEvolution(s, { sourceId: charmander.id, targetId: charmeleon.id });
    expect(s.evolvedThisTurn).toBe(true);
    expect(legalEvolutions(s)).toHaveLength(0);
  });

  it("보관된 target 으로도 진화 가능", () => {
    const charmander = findCard((c) => c.name === "파이리");
    const charmeleon = findCard((c) => c.name === "리자드");
    const s = soloState({
      scored: [charmander.id], reserved: [charmeleon.id], bonus: { yellow: 3 },
    });
    const evos = legalEvolutions(s);
    expect(evos.length).toBe(1);
    applyEvolution(s, evos[0]!);
    expect(s.players[0]!.scored).toContain(charmeleon.id);
    expect(s.players[0]!.reserved).not.toContain(charmeleon.id);
  });
});

describe("limits", () => {
  it("10볼 한도: take3 위반 시 해당 액션 미생성", () => {
    // 8개 보유 → take3(11) 불가, take2(10) 가능(공급≥4)
    const s = soloState({ balls: { red: 4, blue: 4 } });
    const actions = legalMainActions(s);
    const take3s = actions.filter((a) => a.type === "take3");
    expect(take3s).toHaveLength(0);
  });

  it("보관 한도 3장 초과 시 reserve 미생성", () => {
    const cards = CARDS.filter((c) => c.tier === 1).slice(0, 4);
    const s = soloState({ board: [cards[3]!.id], reserved: [cards[0]!.id, cards[1]!.id, cards[2]!.id] });
    const actions = legalMainActions(s).filter((a) => a.type === "reserve");
    expect(actions).toHaveLength(0);
  });

  it("마스터볼 공급 0 이면 reserve 시 획득 없음", () => {
    const card = findCard((c) => c.tier === 1);
    const s = soloState({ board: [card.id], supply: { gold: 0 } });
    s.decks[1] = [];
    applyMainAction(s, { type: "reserve", cardId: card.id });
    expect(s.players[0]!.balls.gold).toBe(0);
    expect(s.players[0]!.reserved).toContain(card.id);
  });
});

describe("end & winner", () => {
  it("18점 도달 → triggeredEnd, 시작플레이어로 돌아오면 ended", () => {
    const s = createGame(1, 2);
    s.currentPlayer = 0;
    s.startingPlayer = 0;
    // 플레이어0 에 18점짜리 점수 카드 4장(리자몽×3 + 이상해꽃 같은 대량) 세팅은 어려우니
    // 점수 직접 검증: 18점 도달 플래그 확인은 finishTurn 경유
    const charizard = findCard((c) => c.name === "리자몽"); // 5점
    s.players[0]!.scored = [charizard.id, charizard.id, charizard.id, charizard.id]; // 20점
    finishTurn(s); // p0 가 20점 → triggeredEnd
    expect(s.triggeredEnd).toBe(true);
    expect(s.ended).toBe(false); // 다음이 p1
    // p1 턴 종료 후 p0 로 돌아오면 ended
    s.currentPlayer = 1;
    finishTurn(s);
    expect(s.ended).toBe(true);
  });

  it("rankPlayers: 점수 → 진화수 → 카드수 tie-breaker", () => {
    const s = createGame(1, 3);
    const five = findCard((c) => c.name === "리자몽").id;
    const zero = findCard((c) => c.name === "꼬마돌").id; // 0점
    // p0: 10점, 진화2 ; p1: 10점, 진화1 ; p2: 10점, 진화1, 카드 더 많음
    s.players[0]!.scored = [five, five]; s.players[0]!.evolutions = 2;
    s.players[1]!.scored = [five, five]; s.players[1]!.evolutions = 1;
    s.players[2]!.scored = [five, five, zero]; s.players[2]!.evolutions = 1;
    const ranked = rankPlayers(s);
    expect(ranked[0]).toBe(0); // 진화수 최다
    expect(ranked[1]).toBe(2); // 동점 진화, 카드수 더 많음
    expect(ranked[2]).toBe(1);
  });

  it("winnerId = 순위 1위", () => {
    const s = createGame(1, 2);
    const five = findCard((c) => c.name === "거북왕").id;
    s.players[0]!.scored = [five];
    s.players[1]!.scored = [];
    expect(winnerId(s)).toBe(0);
  });
});

describe("integration: deterministic full turn", () => {
  it("같은 시드·같은 액션 시퀀스 → 같은 결과", () => {
    const run = (seed: number) => {
      const s = createGame(seed, 4);
      const log: string[] = [];
      for (let i = 0; i < 8 && !s.ended; i++) {
        const actions = legalMainActions(s);
        if (actions.length === 0) { finishTurn(s); continue; }
        // 결정론적 선택: 첫 액션
        const a = actions[0]!;
        const evos = legalEvolutions(s);
        takeTurn(s, a, evos[0] ?? null);
        log.push(`${a.type}`);
      }
      return { log, ended: s.ended, winner: winnerId(s) };
    };
    expect(run(123)).toEqual(run(123));
  });
});
