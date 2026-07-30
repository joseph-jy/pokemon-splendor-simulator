// 전략 가중치(STRATEGY.md §2.3 권장 시작점). 튜닝 대상.
// AI_PLAN.md 1단계: policy.ts 의 평가·탐색 상수 중 영향이 큰 것을 모아
// 자기대국 튜닝(scripts/tune.ts)으로 최적화한다. 모든 정책 함수는 이 타입을 주입받는다.
export interface StrategyWeights {
  /** 점수 가치 */
  pts: number;
  /** 보너스 할인 가치 */
  bonus: number;
  /** 진화 연결 가치 */
  evo: number;
  /** 목표 테크 정렬 */
  goal: number;
  /** 획득 비용 패널티 */
  cost: number;
  /** 진화 tie-breaker */
  tiebreak: number;
  /** 보관 시 V_card 감쇄(즉시 효과 아님) */
  reserve: number;
  /** 마스터볼 획득 가치 */
  master: number;
  /** 비공개 보관 기댓값 */
  blind: number;
  /** 볼 가치: 목표 색 기본치 */
  ballGoal: number;
  /** 볼 가치: 비목표 색 기본치 */
  ballOff: number;
  /** 카드 비용 패널티 스케일 */
  costScale: number;
  /** 같은 색 2개 획득 효율 보너스 */
  take2Bonus: number;
  /** 압박 평가: 다음 진화 단계 가산 */
  pressureEvo: number;
  /** 압박 평가: 부족 볼 감산 */
  pressureMissing: number;
  /** 상태 평가: 점수 계수 */
  evalPts: number;
  /** 상태 평가: 보너스 계수 */
  evalBonus: number;
  /** 상태 평가: 템포(즉시 획득 가능성) 계수 */
  evalTempo: number;
  /** 상태 평가: 상대 대비 점수차 계수 */
  ptDiff: number;
  /** 강화 탐색: 상대 견제(block) 계수 */
  block: number;
  /** 강화 탐색: rollout 후 상태 평가 혼합비 */
  mixAfter: number;
}

/** 기본 가중치. 자기대국 튜닝으로 갱신한다(AI_PLAN.md 1단계). */
export const WEIGHTS: StrategyWeights = {
  pts: 1.0,
  bonus: 0.6,
  evo: 1.5,
  goal: 0.5,
  cost: 1.0,
  tiebreak: 0.4,
  reserve: 0.45,
  master: 0.8,
  blind: 0.15,
  ballGoal: 0.55,
  ballOff: 0.04,
  costScale: 0.22,
  take2Bonus: 0.18,
  pressureEvo: 2.8,
  pressureMissing: 0.75,
  evalPts: 11,
  evalBonus: 1.35,
  evalTempo: 0.65,
  ptDiff: 8,
  block: 0.65,
  mixAfter: 0.58,
};

/** 몬테카를로 사용자 정책 소프트선택 폭. */
export const USER_TOP_K = 3;
/** 소프트맥스 온도(높을수록 균등). */
export const USER_SOFTMAX_TEMP = 0.6;
