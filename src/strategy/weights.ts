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
  /** 견제: 위협 카드 기본치(점수와 무관한 선점 가치) */
  blockBase: number;
  /** 견제: 카드 점수 1점당 가치 */
  blockPts: number;
  /** 견제: 상대의 다음 진화 단계 카드 가산(진화 저격) */
  blockEvo: number;
  /** 견제: 희귀·전설/환상 카드 가산 */
  blockNoble: number;
  /** 견제: 선두(12점 이상) 상대일 때 점수 1점당 추가 가치 */
  blockLeader: number;
  /**
   * 견제: 선제 견제 계수. 상대가 *아직* 못 사지만 볼 몇 개만 더 모으면 살 수 있는
   * 카드의 견제 가치 = (즉시 위협 가치) × blockNear / 부족 볼 수. 0 이면 비활성.
   */
  blockNear: number;
  /** 견제: 선제 견제로 볼 부족분을 몇 개까지 위협으로 볼지 */
  blockNearWindow: number;
  /** 강화 탐색: rollout 후 상태 평가 혼합비 */
  mixAfter: number;
}

/**
 * 기본 가중치 — CEM 자기대국 튜닝 결과(AI_PLAN.md 1단계 재시도, 2026-07-31).
 *
 * `tuning-results/tune-seed4.json` 의 `mean` 후보. 20세대 × 개체 20 × 96판/후보,
 * 적합도도 전체 탐색 예산으로 측정(과거 실패 라운드의 "예산 불일치" 교훈 반영).
 * 확증 매치(4인, 후보 1 vs 기준 3, 기준선 25%): 시드 8181 **46.0% ±4.5%p**,
 * 시드 9292 **44.6% ±4.4%p** — 두 시드 모두 하한이 기준선을 크게 상회해 채택.
 *
 * 견제 항(`blockPts`/`blockEvo`/`blockNoble`/`blockLeader`)은 어블레이션(STRATEGY.md §4.1)에서
 * 0 으로 내린 뒤 CEM 에 자유롭게 다시 올릴 기회를 줬는데도 **모두 0 근방에 머물렀고**,
 * 대신 무차별 견제치(`blockBase`)와 견제 계수(`block`)가 올라갔다 → 어블레이션 결론의 독립 확인.
 * 구 견제 가중치는 `scripts/eval-players.ts` 의 `legacy` 모드로 보존.
 */
export const WEIGHTS: StrategyWeights = {
  pts: 0.6382,
  bonus: 0.633,
  evo: 1.218,
  goal: 0.5367,
  cost: 0.7763,
  tiebreak: 0.636,
  reserve: 0.2924,
  master: 0.7734,
  blind: 0.1834,
  ballGoal: 0.9091,
  ballOff: 0.09341,
  costScale: 0.02967,
  take2Bonus: 0.1848,
  pressureEvo: 2.894,
  pressureMissing: 0.8873,
  evalPts: 2.882,
  evalBonus: 2.076,
  evalTempo: 0.652,
  ptDiff: 9.951,
  block: 0.921,
  blockBase: 2.251,
  blockPts: 0.004929,
  blockEvo: 0.03105,
  blockNoble: 0.02994,
  blockLeader: 0.05774,
  blockNear: 0.03295,
  blockNearWindow: 1.759,
  mixAfter: 0.03966,
};

// MCTS 도 이 벡터를 롤아웃·후보 pre-score 에 쓴다. 튜닝은 휴리스틱(`chooseStrongTurn`)
// 적합도로 돌렸으므로 "MCTS 에는 이전 벡터가 나은가"를 인원별로 분리 측정했는데
// (4인 +4.2%p / 3인 -4.9%p / 2인 +1.4%p, 셀당 ±5.3%p) 방향이 일관되지 않아 **단일 벡터를 유지**한다.
// 재현: `npm run eval:players -- --mode=mcts --mctsw=prev`. 상세는 AI_PLAN.md.

/** 몬테카를로 사용자 정책 소프트선택 폭. */
export const USER_TOP_K = 3;
/** 소프트맥스 온도(높을수록 균등). */
export const USER_SOFTMAX_TEMP = 0.6;
