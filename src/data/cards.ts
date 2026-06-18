// 정적 카드 데이터 — GAME.md 카드 목록을 인코딩.
// 진화 라인별로 보너스색·진화 대상을 공유하므로 라인 스펙을 기준으로 전개.
// 일부 원본 표기 오탈자는 카드 패턴 기준으로 보정한다(예: 신뇽 첫 카드, 버터플).
import type { CardDef, Color, ColorMap, Tier } from "@/game/types";

/** 한글 이름 → romanized(에셋 파일명). 동일 포켓몬은 단계별로 서로 다른 이름·romanized. */
export const ROMAN: Record<string, string> = {
  // 1단계
  파이리: "charmander", 이상해씨: "bulbasaur", 꼬부기: "squirtle", 케이시: "abra", 미뇽: "dratini",
  꼬마돌: "geodude", 고오스: "gastly", 알통몬: "machop", 캐터피: "caterpie", 뿔충이: "weedle",
  구구: "pidgey", 니드런: "nidoran", 모다피: "bellsprout", 발챙이: "poliwag", 뚜벅초: "oddish",
  // 2단계
  리자드: "charmeleon", 이상해풀: "ivysaur", 어니부기: "wartortle", 윤겔라: "kadabra", 신뇽: "dragonair",
  데구리: "graveler", 고우스트: "haunter", 근육몬: "machoke", 단데기: "metapod", 딱충이: "kakuna",
  피죤: "pidgeotto", 니드리나: "nidorina", 우츠동: "weepinbell", 슈륙챙이: "poliwhirl", 냄새꼬: "gloom",
  // 3단계
  리자몽: "charizard", 이상해꽃: "venusaur", 거북왕: "blastoise", 후딘: "alakazam", 망나뇽: "dragonite",
  딱구리: "golem", 팬텀: "gengar", 괴력몬: "machamp", 버터플: "butterfree", 독침붕: "beedrill",
  피죤투: "pidgeot", 니드퀸: "nidoqueen", 우츠보트: "victreebel", 강챙이: "poliwrath", 라플레시아: "vileplume",
  // 희귀
  라플라스: "lapras", 메타몽: "ditto", 프테라: "aerodactyl", 잠만보: "snorlax", 이브이: "eevee",
  // 전설/환상
  썬더: "zapdos", 뮤: "mew", 프리져: "articuno", 파이어: "moltres", 뮤츠: "mewtwo",
};

/** 진화 라인: 세 단계 이름 + 라인 보너스색(3단계 모두 동일). */
interface LineSpec {
  readonly color: Color;
  readonly s1: string;
  readonly s2: string;
  readonly s3: string;
}

const LINES: readonly LineSpec[] = [
  { color: "blue", s1: "파이리", s2: "리자드", s3: "리자몽" },
  { color: "yellow", s1: "이상해씨", s2: "이상해풀", s3: "이상해꽃" },
  { color: "red", s1: "꼬부기", s2: "어니부기", s3: "거북왕" },
  { color: "pink", s1: "케이시", s2: "윤겔라", s3: "후딘" },
  { color: "black", s1: "미뇽", s2: "신뇽", s3: "망나뇽" },
  { color: "blue", s1: "꼬마돌", s2: "데구리", s3: "딱구리" },
  { color: "yellow", s1: "고오스", s2: "고우스트", s3: "팬텀" },
  { color: "red", s1: "알통몬", s2: "근육몬", s3: "괴력몬" },
  { color: "pink", s1: "캐터피", s2: "단데기", s3: "버터플" },
  { color: "black", s1: "뿔충이", s2: "딱충이", s3: "독침붕" },
  { color: "blue", s1: "구구", s2: "피죤", s3: "피죤투" },
  { color: "yellow", s1: "니드런", s2: "니드리나", s3: "니드퀸" },
  { color: "red", s1: "모다피", s2: "우츠동", s3: "우츠보트" },
  { color: "pink", s1: "발챙이", s2: "슈륙챙이", s3: "강챙이" },
  { color: "black", s1: "뚜벅초", s2: "냄새꼬", s3: "라플레시아" },
];

/** 1·2단계 카드 스펙: [점수, 비용, 진화비용]. 진화비용은 단계 상승 시 필요한 컬러 보너스. */
type EvoCardSpec = [points: number, cost: ColorMap, evoCost: ColorMap];
/** 3단계 카드 스펙: [점수, 비용]. 진화 없음. */
type LeafCardSpec = [points: number, cost: ColorMap];

// 라인 순서는 LINES 와 동일. 각 라인의 1·2·3단계 카드들을 GAME.md 표 순서대로.
const STAGE1: readonly (readonly EvoCardSpec[])[] = [
  // 파이리
  [[1, { black: 3, pink: 2 }, { yellow: 3 }], [1, { blue: 4 }, { yellow: 3 }]],
  // 이상해씨
  [[1, { red: 3, black: 2 }, { pink: 3 }], [1, { yellow: 4 }, { pink: 3 }]],
  // 꼬부기
  [[1, { pink: 3, blue: 2 }, { black: 3 }], [1, { red: 4 }, { black: 3 }]],
  // 케이시
  [[1, { blue: 3, yellow: 2 }, { red: 3 }], [1, { pink: 4 }, { red: 3 }]],
  // 미뇽
  [[1, { yellow: 3, red: 2 }, { blue: 3 }], [1, { black: 4 }, { blue: 3 }]],
  // 꼬마돌
  [[0, { black: 1, yellow: 1, pink: 1, red: 1 }, { pink: 3 }], [0, { red: 2, yellow: 1, blue: 1 }, { pink: 3 }]],
  // 고오스
  [[0, { blue: 1, red: 1, pink: 1, black: 1 }, { black: 3 }], [0, { pink: 2, black: 1, red: 1 }, { black: 3 }]],
  // 알통몬
  [[0, { blue: 1, yellow: 1, pink: 1, black: 1 }, { yellow: 3 }], [0, { yellow: 2, pink: 1, black: 1 }, { yellow: 3 }]],
  // 캐터피
  [[0, { blue: 1, yellow: 1, red: 1, black: 1 }, { blue: 3 }], [0, { black: 2, blue: 1, yellow: 1 }, { blue: 3 }]],
  // 뿔충이
  [[0, { red: 1, yellow: 1, pink: 1, blue: 1 }, { red: 3 }], [0, { blue: 2, red: 1, pink: 1 }, { red: 3 }]],
  // 구구
  [[0, { yellow: 2, black: 1 }, { red: 2 }], [0, { blue: 2, red: 2 }, { red: 2 }], [0, { pink: 3 }, { red: 2 }]],
  // 니드런
  [[0, { red: 2, pink: 1 }, { blue: 2 }], [0, { blue: 2, yellow: 2 }, { blue: 2 }], [0, { black: 3 }, { blue: 2 }]],
  // 모다피
  [[0, { black: 2, blue: 1 }, { pink: 2 }], [0, { pink: 2, red: 2 }, { pink: 2 }], [0, { yellow: 3 }, { pink: 2 }]],
  // 발챙이
  [[0, { blue: 2, yellow: 1 }, { black: 2 }], [0, { pink: 2, black: 2 }, { black: 2 }], [0, { red: 3 }, { black: 2 }]],
  // 뚜벅초
  [[0, { pink: 2, red: 1 }, { yellow: 2 }], [0, { yellow: 2, black: 2 }, { yellow: 2 }], [0, { blue: 3 }, { yellow: 2 }]],
];

const STAGE2: readonly (readonly EvoCardSpec[])[] = [
  // 리자드
  [[3, { yellow: 4, black: 4, red: 1 }, { red: 4 }], [3, { blue: 6 }, { red: 4 }]],
  // 이상해풀
  [[3, { red: 4, pink: 4, blue: 1 }, { blue: 4 }], [3, { yellow: 6 }, { blue: 4 }]],
  // 어니부기
  [[3, { blue: 4, black: 4, pink: 1 }, { pink: 4 }], [3, { red: 6 }, { pink: 4 }]],
  // 윤겔라
  [[3, { red: 4, yellow: 4, black: 1 }, { black: 4 }], [3, { pink: 6 }, { black: 4 }]],
  // 신뇽 (대칭 보정)
  [[3, { blue: 4, pink: 4, yellow: 1 }, { yellow: 4 }], [3, { black: 6 }, { yellow: 4 }]],
  // 데구리
  [[2, { pink: 4, yellow: 2, black: 1 }, { black: 3 }], [2, { blue: 5, red: 2 }, { black: 3 }]],
  // 고우스트
  [[2, { black: 4, pink: 2, red: 1 }, { red: 3 }], [2, { yellow: 5, blue: 2 }, { red: 3 }]],
  // 근육몬
  [[2, { yellow: 4, black: 2, blue: 1 }, { blue: 3 }], [2, { red: 5, pink: 2 }, { blue: 3 }]],
  // 단데기
  [[2, { blue: 4, red: 2, yellow: 1 }, { yellow: 3 }], [2, { pink: 5, black: 2 }, { yellow: 3 }]],
  // 딱충이
  [[2, { red: 4, blue: 2, pink: 1 }, { pink: 3 }], [2, { black: 5, yellow: 2 }, { pink: 3 }]],
  // 피죤
  [[1, { blue: 3, pink: 2, black: 2 }, { red: 4 }], [1, { red: 3, yellow: 2, pink: 2 }, { red: 4 }]],
  // 니드리나
  [[1, { yellow: 3, pink: 2, red: 2 }, { blue: 4 }], [1, { blue: 3, pink: 2, black: 2 }, { blue: 4 }]],
  // 우츠동
  [[1, { red: 3, black: 2, yellow: 2 }, { pink: 4 }], [1, { pink: 3, yellow: 2, black: 2 }, { pink: 4 }]],
  // 슈륙챙이
  [[1, { pink: 3, blue: 2, yellow: 2 }, { black: 4 }], [1, { black: 3, blue: 2, red: 2 }, { black: 4 }]],
  // 냄새꼬
  [[1, { black: 3, blue: 2, red: 2 }, { yellow: 4 }], [1, { yellow: 3, blue: 2, red: 2 }, { yellow: 4 }]],
];

const STAGE3: readonly (readonly LeafCardSpec[])[] = [
  // 리자몽
  [[5, { black: 7, yellow: 3 }]],
  // 이상해꽃
  [[5, { red: 7, pink: 3 }]],
  // 거북왕
  [[5, { blue: 7, black: 3 }]],
  // 후딘
  [[5, { yellow: 7, red: 3 }]],
  // 망나뇽
  [[5, { pink: 7, blue: 3 }]],
  // 딱구리
  [[4, { pink: 6, red: 4 }]],
  // 팬텀
  [[4, { black: 6, blue: 4 }]],
  // 괴력몬
  [[4, { yellow: 6, pink: 4 }]],
  // 버터플
  [[4, { blue: 6, black: 4 }]],
  // 독침붕
  [[4, { red: 6, yellow: 4 }]],
  // 피죤투
  [[3, { blue: 5, black: 2, yellow: 2 }]],
  // 니드퀸
  [[3, { yellow: 5, red: 2, pink: 2 }]],
  // 우츠보트
  [[3, { red: 5, black: 2, blue: 2 }]],
  // 강챙이
  [[3, { pink: 5, yellow: 2, red: 2 }]],
  // 라플레시아
  [[3, { black: 5, blue: 2, pink: 2 }]],
];

/** 희귀 카드 스펙: [이름, 보너스색, 비용]. 점수 0, 보너스 2. */
const RARE: readonly (readonly [name: string, color: Color, cost: ColorMap])[] = [
  ["라플라스", "red", { black: 3, blue: 2 }],
  ["메타몽", "blue", { pink: 3, yellow: 2 }],
  ["프테라", "yellow", { blue: 3, pink: 2 }],
  ["잠만보", "pink", { red: 3, black: 2 }],
  ["이브이", "black", { yellow: 3, red: 2 }],
];

/** 전설/환상 카드 스펙: [이름, 보너스색, 비용]. 점수 2, 보너스 2. */
const LEGENDARY: readonly (readonly [name: string, color: Color, cost: ColorMap])[] = [
  ["썬더", "red", { pink: 3, blue: 3, yellow: 3 }],
  ["뮤", "blue", { black: 3, yellow: 3, red: 3 }],
  ["프리져", "yellow", { red: 3, pink: 3, black: 3 }],
  ["파이어", "pink", { blue: 3, yellow: 3, black: 3 }],
  ["뮤츠", "black", { pink: 3, red: 3, blue: 3 }],
];

const counters: Record<string, number> = {};
function nextId(prefix: string): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}-${String(counters[prefix]).padStart(3, "0")}`;
}

function bonusOf(color: Color, n: number): ColorMap {
  return { [color]: n };
}

function build(): CardDef[] {
  const out: CardDef[] = [];

  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i]!;
    // 1단계
    for (const [points, cost, evoCost] of STAGE1[i]!) {
      out.push({
        id: nextId("s1"), name: line.s1, romanized: ROMAN[line.s1], tier: 1, points,
        bonus: bonusOf(line.color, 1), cost, evolvesTo: ROMAN[line.s2], evoCost,
      });
    }
    // 2단계
    for (const [points, cost, evoCost] of STAGE2[i]!) {
      out.push({
        id: nextId("s2"), name: line.s2, romanized: ROMAN[line.s2], tier: 2, points,
        bonus: bonusOf(line.color, 1), cost, evolvesTo: ROMAN[line.s3], evoCost,
      });
    }
    // 3단계
    for (const [points, cost] of STAGE3[i]!) {
      out.push({
        id: nextId("s3"), name: line.s3, romanized: ROMAN[line.s3], tier: 3, points,
        bonus: bonusOf(line.color, 1), cost,
      });
    }
  }

  for (const [name, color, cost] of RARE) {
    out.push({
      id: nextId("rare"), name, romanized: ROMAN[name], tier: "rare", points: 0,
      bonus: bonusOf(color, 2), cost,
    });
  }
  for (const [name, color, cost] of LEGENDARY) {
    out.push({
      id: nextId("leg"), name, romanized: ROMAN[name], tier: "legendary", points: 2,
      bonus: bonusOf(color, 2), cost,
    });
  }

  return out;
}

export const CARDS: readonly CardDef[] = build();

export const CARDS_BY_ID: Readonly<Record<string, CardDef>> = Object.fromEntries(
  CARDS.map((c) => [c.id, c]),
);

/** 모든 카드 id(중복 이름의 변형 포함) 중 romanized 가 일치하는 것들. 진화 대상 검색용. */
export function cardsByRomanized(romanized: string): CardDef[] {
  return CARDS.filter((c) => c.romanized === romanized);
}

/** 단계별 덱 구성(셔플 대상). 각 단계는 동일 이름 변형을 포함한 모든 카드. */
export function deckOf(tier: Tier): CardDef[] {
  return CARDS.filter((c) => c.tier === tier);
}

export const DECK_SIZES: Readonly<Record<Tier, number>> = {
  1: 35, 2: 30, 3: 15, rare: 5, legendary: 5,
};
