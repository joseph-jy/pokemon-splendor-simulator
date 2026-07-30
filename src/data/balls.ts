// 정적 볼 데이터. 색 = 컬러 5종 + gold(마스터볼).
import type { BallColor, BallDef } from "@/game/types";

export const BALLS: readonly BallDef[] = [
  { id: "red", name: "몬스터볼", romanized: "monsterball", color: "red", isMaster: false },
  { id: "blue", name: "슈퍼볼", romanized: "superball", color: "blue", isMaster: false },
  { id: "black", name: "하이퍼볼", romanized: "hyperball", color: "black", isMaster: false },
  { id: "pink", name: "힐볼", romanized: "healball", color: "pink", isMaster: false },
  { id: "yellow", name: "퀵볼", romanized: "quickball", color: "yellow", isMaster: false },
  { id: "gold", name: "마스터볼", romanized: "masterball", color: "gold", isMaster: true },
];

export const BALLS_BY_ID: Readonly<Record<BallColor, BallDef>> = Object.fromEntries(
  BALLS.map((b) => [b.id, b]),
) as Record<BallColor, BallDef>;

/** UI 표시용 컬러명. 마스터볼은 name 그대로 사용. */
export const COLOR_DISPLAY: Readonly<Record<BallColor, string>> = {
  red: "빨강",
  blue: "파랑",
  black: "검정",
  pink: "분홍",
  yellow: "노랑",
  gold: "마스터볼",
};

/** 게임 시작 시 공급 가능한 볼 수(GAME.md 볼 수). 4인 기준. */
export const INITIAL_BALL_SUPPLY: Readonly<Record<BallColor, number>> = {
  red: 7, blue: 7, black: 7, pink: 7, yellow: 7, gold: 5,
};

/** 지원 인원수. */
export const PLAYER_COUNTS: readonly number[] = [2, 3, 4];

/** 인원수별 컬러 볼 차감(4인 기준). 3인 -2, 2인 -3. 마스터볼은 인원 무관. */
export function ballCutFor(numPlayers: number): number {
  return numPlayers <= 2 ? 3 : numPlayers === 3 ? 2 : 0;
}

/** 인원수별 시작 공급량. 2인 4개씩 · 3인 5개씩 · 4인 7개씩 + 마스터볼 5. */
export function ballSupplyFor(numPlayers: number): Record<BallColor, number> {
  const cut = ballCutFor(numPlayers);
  const supply: Record<BallColor, number> = { ...INITIAL_BALL_SUPPLY };
  for (const c of ["red", "blue", "black", "pink", "yellow"] as const) {
    supply[c] = Math.max(0, INITIAL_BALL_SUPPLY[c] - cut);
  }
  return supply;
}

/** 컬러 볼 보유 한도. */
export const MAX_BALLS_IN_HAND = 10;
/** 보관(예약) 카드 한도. */
export const MAX_RESERVED = 3;
/** 각 단계 덱에서 공개되는 카드 수. 희귀·전설은 1장씩. */
export const REVEAL_PER_STAGE = 4;
