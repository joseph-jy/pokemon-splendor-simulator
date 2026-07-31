import type { CardDef, Color, Tier } from "@/game/types";
import { COLORS, isNoble } from "@/game/types";
import type { GameState, PlayerState } from "@/game/state";
import {
  createGame, playerPoints, handBallCount, canAfford, cardOf, discountedCost,
} from "@/game/state";
import { legalEvolutions, legalMainActions, type MainAction, type Evolution } from "@/game/actions";
import { applyMainAction, applyEvolution, canApplyMainAction, finishTurn, winnerId, rankPlayers } from "@/game/engine";
import { chooseStrongTurn } from "@/strategy/policy";
import { serialize, type Snapshot } from "@/game/snapshot";
import type { AiTurnRequest, AiTurnResponse, HintItem, HintRequest, HintResponse, WorkerResponse } from "@/simulator/worker";
import { actionKey } from "@/strategy/mcts";
import { Rng } from "@/game/rng";
import { COLOR_DISPLAY, MAX_RESERVED, MAX_BALLS_IN_HAND, PLAYER_COUNTS, ballSupplyFor } from "@/data/balls";
import SimWorker from "@/simulator/worker?worker&inline";
import {
  el, ballIcon, ballChip, makeCardEl, makeMiniCard, colorCountBadge,
  showTooltip, hideTooltip, aiLogEl,
  showEvolutionToast, showCaptureToast,
} from "./view";

const HUMAN_INDEX = 0;
const MC_N = 200;
const AI_DELAY_MS = 450;
/** AI 턴 MCTS 반복 수. 검증 매치(AI_PLAN.md 2단계) 조건과 동일 — Worker 에서 계산해 UI 비차단. */
const AI_MCTS_ITERATIONS = 400;
/** 치트 모드 추천 수 개수(표시용). */
const CHEAT_TOP_N = 3;
/** Worker 에 요청하는 루트 통계 개수(분석 모드 채점은 전체 후보가 필요). */
const HINT_TOP_N = 12;
const MASTER_BALL_SPEND_CONFIRM = "이 카드를 구입하면 마스터볼이 소모됩니다. 계속하시겠습니까?";
const AI_NAME_CANDIDATES = [
  "리바이", "엘빈", "에렌", "미카사", "라이너", "애니", "지크", "피크", "아르민",
] as const;

const AI_TRAIT_PREFIXES = [
  "신중한", "낙관적인", "대범한", "꼼꼼한", "차분한", "겸손한", "관대한",
] as const;

const DEFAULT_PLAYERS = 4;

type Phase = "setup" | "human-action" | "human-evolve" | "ai" | "ended";

interface UIMsg { kind: "info" | "ok" | "bad"; text: string }

export class Controller {
  private root: HTMLElement;
  private state!: GameState;
  private worker: Worker;
  private phase: Phase = "setup";
  private msg: UIMsg = { kind: "info", text: "" };
  private winRates: number[] = [];
  private winRatesStale = true;
  private winRateRequestSeq = 0;
  private activeWinRateRequestId = 0;
  private aiRng = new Rng(98765);
  private probSeed = 1;
  private aiTurnRequestSeq = 0;
  private activeAiTurnRequestId = 0;
  /** 치트 모드(?cheat=1). 사람 차례에 MCTS 추천 수를 표시한다. */
  private cheatEnabled = false;
  private hintRequestSeq = 0;
  private activeHintRequestId = 0;
  private hints: HintItem[] | null = null;
  private hintsPending = false;
  /** 분석 모드(헤더 토글): 내가 고른 행동을 MCTS 최선 수와 비교해 채점. */
  private analysisEnabled = false;
  private analysisLog: string[] = [];
  /** 추천 계산이 끝나기 전에 행동한 경우, 응답 도착 시 소급 채점할 행동. */
  private pendingGradeAction: MainAction | null = null;
  private aiLog: string[] = [];
  private ballPickColors: Color[] = [];
  private ballPickActive = false;
  private playerNames: string[] = [];
  /** 1~4 단축키로 열린 보유 현황 모달의 플레이어 인덱스. null 이면 닫힘. */
  private cardsModalPlayer: number | null = null;
  /** 직전 게임 인원수(다시 하기 기본값). */
  private numPlayers = DEFAULT_PLAYERS;
  /** 게임 세대 번호. 새 게임/인원 선택 시 증가시켜 이전 게임의 AI 타이머를 무효화한다. */
  private gameSeq = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.cheatEnabled =
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("cheat") === "1";
    this.worker = new SimWorker();
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.kind === "aiturn") {
        this.onAiTurnComputed(e.data);
        return;
      }
      if (e.data.kind === "hint") {
        this.onHintComputed(e.data);
        return;
      }
      if (e.data.requestId !== this.activeWinRateRequestId) return;
      this.winRates = e.data.rates;
      this.winRatesStale = false;
      this.renderProbs();
    };
    document.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  // ── Keyboard shortcuts ──

  /** 1~4: 해당 플레이어 보유 현황 모달 토글(같은 키 재입력 시 닫힘). Esc: 닫기. */
  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

    if (e.key === "Escape") {
      if (this.cardsModalPlayer !== null) {
        e.preventDefault();
        this.closeCardsModal();
      }
      return;
    }

    // 숫자 키(상단 열 + 넘패드) 만 처리
    const digit = /^Digit([1-9])$|^Numpad([1-9])$/.exec(e.code);
    if (!digit) return;
    const index = Number(digit[1] ?? digit[2]) - 1;
    e.preventDefault();
    if (this.phase === "setup") return;
    if (index >= this.state.numPlayers) return;
    this.toggleCardsModal(index);
  }

  private toggleCardsModal(index: number): void {
    hideTooltip();
    this.cardsModalPlayer = this.cardsModalPlayer === index ? null : index;
    this.render();
  }

  private closeCardsModal(): void {
    if (this.cardsModalPlayer === null) return;
    hideTooltip();
    this.cardsModalPlayer = null;
    this.render();
  }

  /** 인원 선택 화면. 게임 진행 중 호출하면 진행 중인 게임은 폐기된다. */
  showSetup(): void {
    this.gameSeq++; // 진행 중이던 게임의 예약된 AI 턴 무효화
    this.activeAiTurnRequestId = 0; // 계산 중이던 Worker AI 응답도 무효화
    this.cardsModalPlayer = null;
    this.phase = "setup";
    this.render();
  }

  newGame(numPlayers = this.numPlayers, seed = (Math.random() * 1e9) | 0): void {
    this.gameSeq++;
    this.numPlayers = numPlayers;
    this.state = createGame(seed, numPlayers, HUMAN_INDEX);
    this.assignPlayerNames(seed);
    this.phase = "human-action";
    this.msg = { kind: "info", text: `${this.state.numPlayers}인 게임 시작 (시드 ${seed}). 선공: ${this.playerName(this.state.startingPlayer)}.` };
    this.winRates = new Array(this.state.numPlayers).fill(1 / this.state.numPlayers);
    this.winRatesStale = true;
    this.activeWinRateRequestId = ++this.winRateRequestSeq;
    this.activeAiTurnRequestId = 0; // 이전 게임의 Worker AI 응답 무효화
    this.activeHintRequestId = 0;
    this.hints = null;
    this.hintsPending = false;
    this.analysisLog = [];
    this.pendingGradeAction = null;
    this.probSeed = (Math.random() * 1e9) | 0;
    this.aiLog = [];
    this.ballPickColors = [];
    this.ballPickActive = false;
    this.cardsModalPlayer = null;
    this.render();
    this.startTurn();
  }

  // ── Helpers ──

  private playerName(i: number): string {
    return this.playerNames[i] ?? (i === HUMAN_INDEX ? "나" : `AI ${i}`);
  }

  private assignPlayerNames(seed: number): void {
    const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
    const candidates = rng.shuffle([...AI_NAME_CANDIDATES]);
    const traits = rng.shuffle([...AI_TRAIT_PREFIXES]);
    this.playerNames = [];
    for (let i = 0; i < this.state.numPlayers; i++) {
      this.playerNames[i] = i === HUMAN_INDEX
        ? "나"
        : `${traits.pop() ?? ""} ${candidates.pop() ?? `AI ${i}`}`;
    }
  }

  private isHumanTurn(): boolean {
    return this.state.currentPlayer === HUMAN_INDEX;
  }

  private setMsg(m: UIMsg): void {
    this.msg = m;
  }

  // ── Turn flow ──

  private startTurn(): void {
    if (this.phase === "setup") return;
    if (this.state.ended) { this.phase = "ended"; this.render(); return; }
    if (this.isHumanTurn()) {
      this.phase = "human-action";
      this.ballPickColors = [];
      this.ballPickActive = false;
      this.setMsg({ kind: "info", text: "내 차례 — 행동을 선택하세요." });
      if (this.cheatEnabled || this.analysisEnabled) this.requestHint();
      this.render();
    } else {
      this.phase = "ai";
      this.setMsg({ kind: "info", text: `${this.playerName(this.state.currentPlayer)} 차례…` });
      this.render();
      const seq = this.gameSeq;
      setTimeout(() => { if (seq === this.gameSeq) this.aiMove(); }, AI_DELAY_MS);
    }
  }

  /** AI 턴 계산을 Worker(MCTS)에 위임. 응답은 onAiTurnComputed 에서 적용. */
  private aiMove(): void {
    if (this.state.ended) { this.startTurn(); return; }
    const requestId = ++this.aiTurnRequestSeq;
    this.activeAiTurnRequestId = requestId;
    const req: AiTurnRequest = {
      kind: "aiturn",
      requestId,
      snapshot: serialize(this.state),
      seed: (this.aiRng.next() * 0x7fffffff) | 0,
      iterations: AI_MCTS_ITERATIONS,
    };
    this.worker.postMessage(req);
  }

  private onAiTurnComputed(msg: AiTurnResponse): void {
    if (msg.requestId !== this.activeAiTurnRequestId) return; // 이전 게임/턴의 응답
    this.activeAiTurnRequestId = 0;
    if (this.phase !== "ai" || this.state.ended) return;
    // Worker 는 동일 스냅샷에서 계산하므로 항상 합법이어야 하나, 방어적으로 검증 후
    // 불일치 시 동기 휴리스틱으로 대체한다.
    let pick = msg.pick;
    if (!pick || !canApplyMainAction(this.state, pick.action)) {
      pick = chooseStrongTurn(this.state, this.aiRng);
    }
    if (!pick) { this.advance(); return; }
    const aiIdx = this.state.currentPlayer;
    const desc = this.describeAction(aiIdx, pick.action);
    applyMainAction(this.state, pick.action);
    if (pick.evolution) {
      applyEvolution(this.state, pick.evolution);
      const targetCard = cardOf(pick.evolution.targetId);
      showEvolutionToast(targetCard.name);
    }
    this.pushAiLog(desc);
    this.advance();
  }

  private advance(): void {
    this.hints = null;
    this.hintsPending = false;
    // 소급 채점 대기 중이면 해당 응답은 살려둔다(다음 requestHint 가 자연히 대체).
    if (!this.pendingGradeAction) this.activeHintRequestId = 0;
    finishTurn(this.state);
    this.requestWinProb();
    this.startTurn();
  }

  // ── Cheat mode (?cheat=1) ──

  /** 사람 차례 시작 시 MCTS 추천 수를 Worker 에 요청. */
  private requestHint(): void {
    const requestId = ++this.hintRequestSeq;
    this.activeHintRequestId = requestId;
    this.hints = null;
    this.hintsPending = true;
    const req: HintRequest = {
      kind: "hint",
      requestId,
      snapshot: serialize(this.state),
      seed: (Math.random() * 0x7fffffff) | 0,
      iterations: AI_MCTS_ITERATIONS,
      topN: HINT_TOP_N,
    };
    this.worker.postMessage(req);
  }

  private onHintComputed(msg: HintResponse): void {
    if (msg.requestId !== this.activeHintRequestId) return; // 지난 턴/게임의 응답
    this.activeHintRequestId = 0;
    this.hintsPending = false;
    // 계산 완료 전에 이미 행동한 경우: 소급 채점만 하고 표시용 hints 는 버린다.
    if (this.pendingGradeAction) {
      const action = this.pendingGradeAction;
      this.pendingGradeAction = null;
      this.gradeWith(msg.hints, action);
      this.render();
      return;
    }
    if (this.phase !== "human-action" || this.state.ended) return;
    this.hints = msg.hints;
    this.render();
  }

  // ── Analysis mode (헤더 토글) ──

  private toggleAnalysis(): void {
    this.analysisEnabled = !this.analysisEnabled;
    if (
      this.analysisEnabled && this.phase === "human-action" &&
      !this.hints && !this.hintsPending && !this.state.ended
    ) {
      this.requestHint();
    }
    this.render();
  }

  /** 사람이 고른 행동을 이번 턴 MCTS 통계와 비교해 채점 로그에 기록. */
  private gradeHumanAction(action: MainAction): void {
    if (this.hints) {
      this.gradeWith(this.hints, action);
      return;
    }
    if (this.hintsPending) {
      this.pendingGradeAction = action; // 응답 도착 시 소급 채점
      return;
    }
    this.pushAnalysis(`🤔 ${this.actionText(action)} — 분석 데이터 없음(모드를 켠 직후예요)`);
  }

  private gradeWith(hints: HintItem[], action: MainAction): void {
    if (hints.length === 0) return;
    const best = hints[0]!; // 최다 방문 = AI 가 뒀을 수
    const key = actionKey(action);
    const chosen = hints.find((h) => actionKey(h.action) === key);
    if (!chosen) {
      this.pushAnalysis(
        `🧐 ${this.actionText(action)} — AI 탐색 후보 밖의 수 (AI 최선: ${this.actionText(best.action)}, 가치 ${Math.round(best.value * 100)})`,
      );
      return;
    }
    const vChosen = Math.round(chosen.value * 100);
    const vBest = Math.round(best.value * 100);
    const diff = vBest - vChosen;
    const label =
      diff <= 1 ? "🌟 최선의 수!" :
      diff <= 4 ? "👍 좋은 수" :
      diff <= 9 ? "🙂 무난한 수" :
      diff <= 15 ? "😅 아쉬운 수" : "💥 실수";
    let line = `${label} ${this.actionText(action)} — 가치 ${vChosen}`;
    if (diff > 1) line += ` (최선: ${this.actionText(best.action)}, 가치 ${vBest})`;
    this.pushAnalysis(line);
  }

  private pushAnalysis(line: string): void {
    this.analysisLog.push(line);
    if (this.analysisLog.length > 5) this.analysisLog.shift();
  }

  // ── AI log ──

  private pushAiLog(desc: string): void {
    this.aiLog.push(desc);
    if (this.aiLog.length > 5) this.aiLog.shift();
  }

  private describeAction(playerIdx: number, action: MainAction): string {
    return `${this.playerName(playerIdx)}: ${this.actionText(action)}`;
  }

  /** 플레이어명 없는 행동 설명(치트 패널·AI 로그 공용). */
  private actionText(action: MainAction): string {
    switch (action.type) {
      case "acquire":
        return `${cardOf(action.cardId).name} 획득`;
      case "reserve":
        return `${cardOf(action.cardId).name} 보관`;
      case "take3":
        return `${action.colors.map((c) => COLOR_DISPLAY[c]).join("+")} 획득`;
      case "take2":
        return `${COLOR_DISPLAY[action.color]} 2개 획득`;
      case "reserveBlind":
        return `${action.tier}단계 더미 보관`;
    }
  }

  // ── Human action handling ──

  private humanPlay(action: MainAction): void {
    if (this.phase !== "human-action") return;

    if (action.type === "acquire" && this.needsMasterBallSpendConfirm(action)) {
      if (!window.confirm(MASTER_BALL_SPEND_CONFIRM)) {
        this.setMsg({ kind: "info", text: "카드 구입을 취소했습니다." });
        this.render();
        return;
      }
    }

    // Show toast for special actions before applying
    if (action.type === "acquire") {
      const card = cardOf(action.cardId);
      if (isNoble(card.tier)) {
        showCaptureToast(card.name);
      }
    }

    if (this.analysisEnabled) this.gradeHumanAction(action);
    applyMainAction(this.state, action);
    this.ballPickActive = false;
    this.ballPickColors = [];
    const evos = legalEvolutions(this.state);
    if (evos.length > 0) {
      this.phase = "human-evolve";
      this.setMsg({ kind: "ok", text: "진화 가능! 진화하거나 건너뛸 수 있습니다." });
      this.render();
    } else {
      this.advance();
    }
  }

  private humanEvolve(evo: Evolution | null): void {
    if (this.phase !== "human-evolve") return;
    if (evo) {
      applyEvolution(this.state, evo);
      const targetCard = cardOf(evo.targetId);
      showEvolutionToast(targetCard.name);
    }
    this.advance();
  }

  // ── Ball pick flow ──

  private startBallPick(): void {
    if (handBallCount(this.state.players[HUMAN_INDEX]!) >= MAX_BALLS_IN_HAND) {
      this.setMsg({ kind: "bad", text: `볼 보유 한도(${MAX_BALLS_IN_HAND}개) — 더 가져올 수 없습니다.` });
      this.render();
      return;
    }
    this.ballPickActive = true;
    this.ballPickColors = [];
    this.render();
  }

  /** 볼 칩 클릭 순환: 0 → 1개 → (2개 가능하면 2개, 아니면 취소) → 2개에서 재클릭 시 취소. */
  private toggleBallColor(c: Color): void {
    if (!this.ballPickActive) return;
    const count = this.ballPickColors.filter((x) => x === c).length;
    const pairMode = this.ballPickColors.length === 2 && new Set(this.ballPickColors).size === 1;
    const canTake2 = legalMainActions(this.state).some((a) => a.type === "take2" && a.color === c);

    if (pairMode) {
      // 이미 같은 색 2개 상태: 같은 색 클릭=취소 / 다른 색 클릭=그 색 1개로 새로 시작
      this.ballPickColors = count === 2 ? [] : [c];
    } else if (count === 0) {
      // 새 색 추가: 최대 3색, 단 손 여유칸(10 한도) 이내로 제한
      const capacity = MAX_BALLS_IN_HAND - handBallCount(this.state.players[HUMAN_INDEX]!);
      const maxSel = Math.min(3, capacity);
      if (this.ballPickColors.length < maxSel) this.ballPickColors.push(c);
    } else {
      // 이미 1개 잡은 색을 재클릭: 그 색만 있고 2개 가능하면 2개로, 아니면 1개 취소
      if (this.ballPickColors.length === 1 && canTake2) {
        this.ballPickColors = [c, c];
      } else {
        this.ballPickColors.splice(this.ballPickColors.indexOf(c), 1);
      }
    }
    this.render();
  }

  private confirmBallPick(): void {
    if (this.ballPickColors.length === 0) return;
    const legal = legalMainActions(this.state);
    const isPair = this.ballPickColors.length === 2 && new Set(this.ballPickColors).size === 1;
    const match = isPair
      ? legal.find((a) => a.type === "take2" && a.color === this.ballPickColors[0])
      : (() => {
          const picked = [...this.ballPickColors].sort();
          return legal.find((a) => {
            if (a.type !== "take3") return false;
            const ac = [...a.colors].sort();
            return ac.length === picked.length && ac.every((v, i) => v === picked[i]);
          });
        })();
    if (match) {
      this.humanPlay(match);
    } else {
      this.setMsg({ kind: "bad", text: "해당 볼 조합을 가져올 수 없습니다." });
      this.render();
    }
  }

  private cancelBallPick(): void {
    this.ballPickActive = false;
    this.ballPickColors = [];
    this.render();
  }

  // ── Card click ──

  private onCardClick(id: string): void {
    const acts = legalMainActions(this.state).filter((a) => a.type === "acquire" && a.cardId === id);
    const act = acts[0];
    if (act) { this.humanPlay(act); return; }
    const card = cardOf(id);
    const me = this.state.players[HUMAN_INDEX]!;
    this.setMsg({ kind: "bad", text: this.whyNotAfford(me, card) });
    this.render();
  }

  private onReserveClick(id: string): void {
    const acts = legalMainActions(this.state).filter((a) => a.type === "reserve" && a.cardId === id);
    const act = acts[0];
    if (act) { this.humanPlay(act); return; }
    const card = cardOf(id);
    const me = this.state.players[HUMAN_INDEX]!;
    this.setMsg({ kind: "bad", text: this.whyNotReserve(me, card) });
    this.render();
  }

  private onReservedCardClick(id: string): void {
    const acts = legalMainActions(this.state).filter((a) => a.type === "acquire" && a.cardId === id);
    const act = acts[0];
    if (act) { this.humanPlay(act); return; }
    const card = cardOf(id);
    const me = this.state.players[HUMAN_INDEX]!;
    this.setMsg({ kind: "bad", text: this.whyNotAfford(me, card) });
    this.render();
  }

  private whyNotAfford(p: PlayerState, card: CardDef): string {
    if (isNoble(card.tier) && p.balls.gold < 1) return "획득 불가: 희귀/전설 카드는 마스터볼 1개가 필요합니다.";
    const cost = discountedCost(card, p.bonus);
    const parts: string[] = [];
    for (const c of COLORS) {
      const need = cost[c] ?? 0;
      if (need > p.balls[c]) parts.push(`${COLOR_DISPLAY[c]} ${need - p.balls[c]}개`);
    }
    return parts.length ? `획득 불가: ${parts.join(", ")} 부족` : "획득 불가";
  }

  private whyNotReserve(p: PlayerState, card: CardDef): string {
    if (isNoble(card.tier)) return "보관 불가: 희귀/전설/환상 카드는 보관할 수 없습니다.";
    if (p.reserved.length >= MAX_RESERVED) return `보관 불가: 보관 한도(${MAX_RESERVED}장) 초과`;
    return "보관 불가";
  }

  private cardBonusColor(card: CardDef): Color | null {
    return COLORS.find((c) => (card.bonus[c] ?? 0) > 0) ?? null;
  }

  private colorTotal(p: PlayerState, c: Color): number {
    return p.bonus[c] + p.balls[c];
  }

  private colorTotalTitle(p: PlayerState, c: Color): string {
    return `${COLOR_DISPLAY[c]} 총점수 ${this.colorTotal(p, c)} (보너스 ${p.bonus[c]} + 보유 볼 ${p.balls[c]})`;
  }

  private needsMasterBallSpendConfirm(action: MainAction): boolean {
    if (action.type !== "acquire" || isNoble(cardOf(action.cardId).tier)) return false;
    return action.pay.gold > 0;
  }

  private renderScoredStacks(cardIds: string[], size: number, label: boolean): HTMLElement {
    const wrap = el("div", { class: "scored-stacks" });
    const byColor = new Map<Color, string[]>();
    for (const c of COLORS) byColor.set(c, []);

    for (const id of cardIds) {
      const card = cardOf(id);
      const color = this.cardBonusColor(card);
      if (color) byColor.get(color)!.push(id);
    }

    for (const c of COLORS) {
      const ids = byColor.get(c)!;
      if (ids.length === 0) continue;
      const stack = el("div", { class: `card-color-stack stack-${c}` });
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const card = cardOf(id);
        const mc = makeMiniCard(card, { size, label });
        mc.style.zIndex = String(i + 1);
        mc.addEventListener("mouseenter", () => showTooltip(mc, card));
        mc.addEventListener("mouseleave", () => hideTooltip());
        stack.append(mc);
      }
      wrap.append(stack);
    }

    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════
  //   RENDER — Left/Right Dashboard Layout
  // ═══════════════════════════════════════════════════════════════════

  render(): void {
    if (this.phase === "setup") {
      this.root.replaceChildren(this.renderSetup());
      return;
    }
    this.root.replaceChildren(
      this.renderGameLayout(),
    );
    if (this.state.ended) {
      this.root.append(this.renderEndOverlay());
    }
    if (this.cardsModalPlayer !== null && this.cardsModalPlayer < this.state.numPlayers) {
      this.root.append(this.renderCardsModal(this.cardsModalPlayer));
    }
  }

  // ── 보유 현황 모달 (단축키 1~4) ──

  /** 플레이어 한 명의 볼·보너스·획득/보관 카드 전체를 크게 보여주는 모달. */
  private renderCardsModal(index: number): HTMLElement {
    const p = this.state.players[index]!;

    // 플레이어 전환 탭 (숫자 키와 동일)
    const tabs = el("div", { class: "cards-modal-tabs" });
    for (let i = 0; i < this.state.numPlayers; i++) {
      tabs.append(el("button", {
        class: `cards-modal-tab${i === index ? " active" : ""}`,
        title: `${i + 1} 키`,
        onclick: () => this.toggleCardsModal(i),
      }, [
        el("span", { class: "cards-modal-tab-key" }, [String(i + 1)]),
        this.playerName(i),
      ]));
    }

    // 볼 보유
    const ballsRow = el("div", { class: "flex flex-wrap gap-1" });
    for (const c of COLORS) {
      if (p.balls[c] > 0) ballsRow.append(ballChip(c, p.balls[c]));
    }
    if (p.balls.gold > 0) ballsRow.append(ballChip("gold", p.balls.gold));
    if (handBallCount(p) === 0) ballsRow.append(el("span", { class: "text-xs opacity-40" }, ["없음"]));

    // 색별 보너스/볼/총점수 표
    const colorRows = COLORS.map((c) => el("tr", { class: this.colorTotal(p, c) === 0 ? "opacity-40" : "" }, [
      el("td", { class: "flex items-center gap-1" }, [ballIcon(c, 18), COLOR_DISPLAY[c]]),
      el("td", { class: "text-center" }, [String(p.bonus[c])]),
      el("td", { class: "text-center" }, [String(p.balls[c])]),
      el("td", { class: "text-center font-bold" }, [String(this.colorTotal(p, c))]),
    ]));
    const colorTable = el("table", { class: "table table-xs cards-modal-table" }, [
      el("thead", {}, [el("tr", {}, [
        el("th", {}, ["색"]), el("th", { class: "text-center" }, ["보너스"]),
        el("th", { class: "text-center" }, ["볼"]), el("th", { class: "text-center" }, ["총점수"]),
      ])]),
      el("tbody", {}, colorRows),
    ]);

    // 획득 카드
    const scored = p.scored.length > 0
      ? this.renderScoredStacks(p.scored, 64, true)
      : el("span", { class: "text-xs opacity-40" }, ["없음"]);

    // 보관 카드 (이 시뮬레이터에서는 AI 보관 카드도 공개)
    const reservedRow = el("div", { class: "card-scroll" });
    for (const id of p.reserved) {
      const card = cardOf(id);
      const mc = makeMiniCard(card, { size: 64, label: true });
      mc.addEventListener("mouseenter", () => showTooltip(mc, card));
      mc.addEventListener("mouseleave", () => hideTooltip());
      reservedRow.append(mc);
    }
    if (p.reserved.length === 0) reservedRow.append(el("span", { class: "text-xs opacity-40" }, ["없음"]));

    const section = (icon: string, title: string, body: Node | string): HTMLElement =>
      el("div", { class: "cards-modal-section" }, [
        el("div", { class: "cards-modal-section-title" }, [
          el("i", { class: `fa-solid ${icon} mr-1` }),
          title,
        ]),
        body,
      ]);

    const dialog = el("div", { class: "cards-modal" }, [
      el("div", { class: "cards-modal-head" }, [
        el("div", { class: "cards-modal-title" }, [
          el("i", { class: `fa-solid ${index === HUMAN_INDEX ? "fa-user" : "fa-robot"} mr-2` }),
          this.playerName(index),
          el("span", { class: "cards-modal-pts" }, [`${playerPoints(p)}점`]),
          el("span", { class: "badge badge-sm badge-ghost" }, [`진화 ${p.evolutions}`]),
          el("span", { class: "badge badge-sm badge-ghost" }, [`볼 ${handBallCount(p)}/${MAX_BALLS_IN_HAND}`]),
        ]),
        el("button", {
          class: "btn btn-xs btn-ghost",
          title: "닫기 (Esc)",
          onclick: () => this.closeCardsModal(),
        }, [el("i", { class: "fa-solid fa-xmark" })]),
      ]),
      tabs,
      el("div", { class: "cards-modal-body" }, [
        section("fa-coins", "보유 볼", ballsRow),
        section("fa-shield-halved", "색별 보너스 · 총점수", colorTable),
        section("fa-trophy", `획득 카드 (${p.scored.length})`, scored),
        section("fa-bookmark", `보관 카드 (${p.reserved.length}/${MAX_RESERVED})`, reservedRow),
      ]),
      el("div", { class: "cards-modal-foot" }, [
        `1~${this.state.numPlayers} 키로 플레이어 전환 · 같은 키 또는 Esc 로 닫기`,
      ]),
    ]);

    const overlay = el("div", { class: "cards-modal-overlay" }, [dialog]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeCardsModal();
    });
    return overlay;
  }

  // ── Setup screen: 인원 선택 ──

  private renderSetup(): HTMLElement {
    const choices = el("div", { class: "setup-choices" });
    for (const n of PLAYER_COUNTS) {
      const perColor = ballSupplyFor(n).red;
      choices.append(el("button", {
        class: `setup-choice${n === this.numPlayers ? " selected" : ""}`,
        onclick: () => this.newGame(n),
      }, [
        el("span", { class: "setup-choice-n" }, [`${n}인`]),
        el("span", { class: "setup-choice-sub" }, [`나 + AI ${n - 1}명`]),
        el("div", { class: "setup-choice-balls" }, [
          ...COLORS.map((c) => ballIcon(c, 18)),
          el("span", {}, [`각 ${perColor}개`]),
        ]),
        el("div", { class: "setup-choice-balls" }, [
          ballIcon("gold", 18),
          el("span", {}, [`마스터볼 ${ballSupplyFor(n).gold}개`]),
        ]),
      ]));
    }

    return el("div", { class: "setup-screen" }, [
      el("div", { class: "setup-card" }, [
        el("h1", { class: "setup-title" }, [
          el("i", { class: "fa-solid fa-gamepad mr-2" }),
          "포켓몬 스플렌더",
        ]),
        el("p", { class: "setup-desc" }, ["플레이 인원을 선택하세요. 인원수에 따라 컬러 볼 공급량이 달라집니다."]),
        choices,
      ]),
    ]);
  }

  private renderGameLayout(): HTMLElement {
    return el("div", { class: "game-layout" }, [
      this.renderLeftPanel(),
      this.renderRightPanel(),
    ]);
  }

  // ── Left panel: header + card field ──

  private renderLeftPanel(): HTMLElement {
    const left = el("div", { class: "game-left" });
    left.append(this.renderHeader());
    left.append(this.renderBoard());
    return left;
  }

  private renderHeader(): HTMLElement {
    const probs = this.buildProbsBars();

    const turnText = this.state.ended ? "게임 종료" : `${this.playerName(this.state.currentPlayer)} 차례`;

    const logEl = aiLogEl();
    for (const entry of this.aiLog) {
      logEl.append(el("div", {}, [entry]));
    }

    const newGameBtn = el("button", {
      class: "btn btn-sm btn-warning btn-outline",
      title: "인원을 다시 선택하고 새 게임을 시작합니다",
      onclick: () => this.showSetup(),
    }, [
      el("i", { class: "fa-solid fa-rotate-right mr-1" }),
      "새 게임",
    ]);

    const analysisBtn = el("button", {
      class: `btn btn-sm ${this.analysisEnabled ? "btn-info" : "btn-ghost btn-outline"}`,
      title: "분석 모드: 내가 고른 행동이 AI 최선 수 대비 얼마나 좋았는지 채점합니다",
      onclick: () => this.toggleAnalysis(),
    }, [
      el("i", { class: "fa-solid fa-chart-line mr-1" }),
      `분석 ${this.analysisEnabled ? "ON" : "OFF"}`,
    ]);

    return el("div", { class: "game-header" }, [
      el("span", { class: "title" }, [
        el("i", { class: "fa-solid fa-gamepad mr-1" }),
        "포켓몬 스플렌더",
      ]),
      probs,
      el("span", { class: "badge badge-ghost" }, [
        el("i", { class: "fa-solid fa-circle-play mr-1" }),
        turnText,
      ]),
      el("span", { class: "badge badge-ghost" }, [
        el("i", { class: "fa-solid fa-users mr-1" }),
        `${this.state.numPlayers}인`,
      ]),
      el("span", {
        class: "badge badge-ghost",
        title: "숫자 키로 해당 플레이어의 보유 볼·카드 현황을 열고, 같은 키로 닫습니다",
      }, [
        el("i", { class: "fa-solid fa-keyboard mr-1" }),
        `1~${this.state.numPlayers} 보유 현황`,
      ]),
      logEl,
      analysisBtn,
      newGameBtn,
    ]);
  }

  // ── Board (card field) ──

  private renderBoard(): HTMLElement {
    const board = el("div", { class: "flex flex-col gap-2 flex-1" });

    // Supply bar
    board.append(this.renderSupplyBar());

    // Tier rows
    const rows: [string, Tier][] = [
      ["1단계", 1], ["2단계", 2], ["3단계", 3],
    ];
    for (const [label, tier] of rows) {
      const rowWrap = el("div", { class: "tier-row" });
      rowWrap.append(el("span", { class: "tier-label" }, [label]));

      const cards = el("div", { class: "tier-cards" });
      for (const id of this.state.board[tier]) cards.append(this.boardCardEl(id));
      rowWrap.append(cards);

      // Blind reserve button
      if (this.isHumanTurn() && this.phase === "human-action") {
        const blinds = legalMainActions(this.state).filter(
          (a): a is Extract<MainAction, { type: "reserveBlind" }> => a.type === "reserveBlind" && a.tier === tier,
        );
        if (blinds.length > 0) {
          rowWrap.append(el("button", {
            class: "blind-reserve-btn",
            onclick: () => this.humanPlay(blinds[0]!),
          }, [
            el("i", { class: "fa-solid fa-eye-slash mr-1" }),
            "더미",
          ]));
        }
      }
      board.append(rowWrap);
    }

    // Noble row
    const nobleRow = el("div", { class: "tier-row" });
    nobleRow.append(el("span", { class: "tier-label" }, ["전설"]));
    const nobleCards = el("div", { class: "tier-cards" });
    for (const id of this.state.board.rare) nobleCards.append(this.boardCardEl(id));
    for (const id of this.state.board.legendary) nobleCards.append(this.boardCardEl(id));
    nobleRow.append(nobleCards);
    board.append(nobleRow);

    return board;
  }

  private renderSupplyBar(): HTMLElement {
    const wrap = el("div", { class: "supply-bar" });
    const order: Color[] = ["red", "blue", "black", "pink", "yellow"];
    const myTurn = this.isHumanTurn() && this.phase === "human-action";

    for (const c of order) {
      const supply = this.state.supply[c];
      const picked = this.ballPickColors.includes(c);
      const cls = ["supply-item"];
      if (picked) cls.push("picked");
      if (myTurn && supply > 0) cls.push("pickable");

      const ballEl = el("div", { class: cls.join(" ") }, [
        ballIcon(c, 22),
        el("span", { class: "font-bold" }, [String(supply)]),
      ]);

      if (myTurn && supply > 0) {
        ballEl.addEventListener("click", () => {
          if (!this.ballPickActive) this.startBallPick();
          this.toggleBallColor(c);
        });
      }

      wrap.append(ballEl);
    }

    // Gold (not pickable via take3)
    const goldSupply = this.state.supply.gold;
    const goldEl = el("div", { class: "supply-item" }, [
      ballIcon("gold", 22),
      el("span", { class: "font-bold" }, [String(goldSupply)]),
    ]);
    wrap.append(goldEl);

    // Ball pick flow controls
    if (this.ballPickActive) {
      // 같은 색 그룹화: "검정 2개", "빨강, 파랑" 등으로 표기
      const counts = new Map<Color, number>();
      for (const c of this.ballPickColors) counts.set(c, (counts.get(c) ?? 0) + 1);
      const labelParts: string[] = [];
      for (const [c, n] of Array.from(counts)) {
        labelParts.push(n > 1 ? `${COLOR_DISPLAY[c]} ${n}개` : COLOR_DISPLAY[c]);
      }
      const flow = el("div", { class: "ball-pick-flow" });
      flow.append(el("span", { class: "pick-label" }, [
        el("i", { class: "fa-solid fa-hand-pointer mr-1" }),
        `선택: ${labelParts.join(", ") || "없음"}`,
      ]));
      flow.append(el("span", { class: "pick-hint" }, ["서로 다른 색 1~3개 · 같은 색 2개"]));
      const confirmBtn = el("button", {
        class: "btn btn-xs btn-success",
        onclick: () => this.confirmBallPick(),
      }, [
        el("i", { class: "fa-solid fa-check mr-1" }),
        "가져오기",
      ]);
      if (this.ballPickColors.length === 0) confirmBtn.setAttribute("disabled", "");
      flow.append(confirmBtn);
      flow.append(el("button", {
        class: "btn btn-xs btn-ghost",
        onclick: () => this.cancelBallPick(),
      }, ["취소"]));
      wrap.append(flow);
    }

    // Take2 buttons
    if (myTurn && !this.ballPickActive) {
      const legal = legalMainActions(this.state);
      const take2s = legal.filter((a): a is Extract<MainAction, { type: "take2" }> => a.type === "take2");
      if (take2s.length > 0) {
        for (const a of take2s) {
          wrap.append(el("button", {
            class: "take2-btn",
            onclick: () => this.humanPlay(a),
          }, [
            ballIcon(a.color, 14),
            `${COLOR_DISPLAY[a.color]} 2개`,
          ]));
        }
      }

      // Start ball pick hint
      const hasTake3 = legal.some((a) => a.type === "take3");
      if (hasTake3) {
        wrap.append(el("span", {
          class: "text-xs text-warning cursor-pointer opacity-70 hover:opacity-100",
          title: "서로 다른 색 볼을 1~3개까지 1개씩 가져올 수 있습니다",
          onclick: () => this.startBallPick(),
        }, [
          el("i", { class: "fa-solid fa-hand-pointer mr-1" }),
          "볼 선택 (1~3색) →",
        ]));
      }
    }

    return wrap;
  }

  private boardCardEl(id: string): HTMLElement {
    const card = cardOf(id);
    const myTurn = this.isHumanTurn() && this.phase === "human-action";
    const affordable = canAfford(this.state.players[HUMAN_INDEX]!, card);
    const isStage = card.tier === 1 || card.tier === 2 || card.tier === 3;
    const me = this.state.players[HUMAN_INDEX]!;
    const reserveOk = isStage && me.reserved.length < MAX_RESERVED;

    const clickable = myTurn;
    const dim = myTurn && !affordable;
    const showReserveBtn = myTurn && isStage && reserveOk;

    const node = makeCardEl(card, {
      clickable,
      affordable: myTurn && affordable,
      dim,
      reserveBtn: showReserveBtn,
      onclick: clickable ? () => this.onCardClick(id) : undefined,
    });

    node.addEventListener("mouseenter", () => showTooltip(node, card));
    node.addEventListener("mouseleave", () => hideTooltip());

    if (showReserveBtn) {
      const btn = node.querySelector(".reserve-btn");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onReserveClick(id);
        });
      }
    }

    return node;
  }

  // ── Right panel: player status + token bank ──

  private renderRightPanel(): HTMLElement {
    const right = el("div", { class: "game-right" });

    // Current player info (Me)
    right.append(this.renderMePanel());

    // AI panels
    for (let i = 0; i < this.state.numPlayers; i++) {
      if (i !== HUMAN_INDEX) right.append(this.renderAiPanel(i));
    }

    // Action / message area
    right.append(this.renderActionPanel());

    return right;
  }

  private renderMePanel(): HTMLElement {
    const p = this.state.players[HUMAN_INDEX]!;
    const cls = ["player-panel"];
    if (this.state.currentPlayer === HUMAN_INDEX && !this.state.ended) cls.push("current-turn");

    const panel = el("div", { class: cls.join(" ") });

    // Name + points
    panel.append(el("div", { class: "flex items-center justify-between" }, [
      el("div", { class: "flex items-center gap-2" }, [
        el("div", { class: "avatar placeholder" }, [
          el("div", { class: "bg-warning text-warning-content w-8 rounded-full" }, [
            el("i", { class: "fa-solid fa-user text-sm" }),
          ]),
        ]),
        el("span", { class: "panel-name" }, ["나"]),
      ]),
      el("div", { class: "flex items-center gap-2" }, [
        el("span", { class: "panel-pts text-lg" }, [`${playerPoints(p)}점`]),
        el("span", { class: "badge badge-sm badge-ghost" }, [`진화 ${p.evolutions}`]),
      ]),
    ]));

    // Balls
    const ballsSection = el("div", { class: "panel-section" });
    ballsSection.append(el("div", { class: "text-[9px] opacity-50 mb-1" }, [
      el("i", { class: "fa-solid fa-coins mr-1" }),
      "볼",
    ]));
    const ballsRow = el("div", { class: "flex flex-wrap gap-1" });
    for (const c of COLORS) {
      if (p.balls[c] > 0) ballsRow.append(ballChip(c, p.balls[c]));
    }
    if (p.balls.gold > 0) ballsRow.append(ballChip("gold", p.balls.gold));
    if (handBallCount(p) === 0) ballsRow.append(el("span", { class: "text-xs opacity-30" }, ["없음"]));
    ballsSection.append(ballsRow);
    panel.append(ballsSection);

    // Color totals: bonus + held colored balls
    const totalSection = el("div", { class: "panel-section" });
    totalSection.append(el("div", { class: "text-[9px] opacity-50 mb-1" }, [
      el("i", { class: "fa-solid fa-shield-halved mr-1" }),
      "총점수",
    ]));
    const totalRow = el("div", { class: "flex flex-wrap gap-1" });
    for (const c of COLORS) {
      const total = this.colorTotal(p, c);
      if (total > 0) totalRow.append(colorCountBadge(c, total, this.colorTotalTitle(p, c)));
    }
    const hasTotal = COLORS.some((c) => this.colorTotal(p, c) > 0);
    if (!hasTotal) totalRow.append(el("span", { class: "text-xs opacity-30" }, ["없음"]));
    totalSection.append(totalRow);
    panel.append(totalSection);

    // Scored cards grouped by bonus color
    const scoredSection = el("div", { class: "panel-section" });
    scoredSection.append(el("div", { class: "text-[9px] opacity-50 mb-1" }, [
      el("i", { class: "fa-solid fa-trophy mr-1" }),
      `획득 (${p.scored.length})`,
    ]));
    scoredSection.append(
      p.scored.length > 0
        ? this.renderScoredStacks(p.scored, 48, true)
        : el("span", { class: "text-xs opacity-30" }, ["없음"]),
    );
    panel.append(scoredSection);

    // Reserved cards
    const reservedSection = el("div", { class: "panel-section" });
    reservedSection.append(el("div", { class: "text-[9px] opacity-50 mb-1" }, [
      el("i", { class: "fa-solid fa-bookmark mr-1" }),
      `보관 (${p.reserved.length}/${MAX_RESERVED})`,
    ]));
    const reservedScroll = el("div", { class: "card-scroll" });
    for (const id of p.reserved) {
      const card = cardOf(id);
      const affordable = canAfford(p, card);
      const myTurn = this.isHumanTurn() && this.phase === "human-action";
      const mc = makeMiniCard(card, {
        size: 48,
        label: true,
        affordable: myTurn && affordable,
        onclick: myTurn ? () => this.onReservedCardClick(id) : undefined,
      });
      mc.addEventListener("mouseenter", () => showTooltip(mc, card));
      mc.addEventListener("mouseleave", () => hideTooltip());
      reservedScroll.append(mc);
    }
    if (p.reserved.length === 0) reservedScroll.append(el("span", { class: "text-xs opacity-30" }, ["없음"]));
    reservedSection.append(reservedScroll);
    panel.append(reservedSection);

    // 메시지 + 진화 UI (획득 불가 / 진화 가능 등) — "나" 패널 아래에 표기
    panel.append(this.renderMyActionFeedback());

    return panel;
  }

  /** 치트 모드 추천 수 패널(?cheat=1, 사람 차례 한정). */
  private buildCheatPanel(): HTMLElement {
    const panel = el("div", { class: "cheat-panel" });
    panel.append(el("div", { class: "cheat-title" }, ["🃏 치트 — MCTS 추천 수"]));
    if (this.hintsPending || !this.hints) {
      panel.append(el("div", { class: "cheat-row text-xs opacity-60" }, ["계산 중…"]));
      return panel;
    }
    if (this.hints.length === 0) {
      panel.append(el("div", { class: "cheat-row text-xs opacity-60" }, ["추천 없음"]));
      return panel;
    }
    const top = this.hints.slice(0, CHEAT_TOP_N);
    const totalVisits = this.hints.reduce((a, h) => a + h.visits, 0);
    top.forEach((h, i) => {
      const share = totalVisits > 0 ? Math.round((h.visits / totalVisits) * 100) : 0;
      panel.append(el("div", { class: "cheat-row" }, [
        el("span", { class: "cheat-rank" }, [`${i + 1}`]),
        el("span", { class: "cheat-desc" }, [this.actionText(h.action)]),
        el("span", { class: "cheat-meta", title: "탐색 선호도(방문 비중) · 기대 가치(0~100)" }, [
          `선호 ${share}% · 가치 ${Math.round(h.value * 100)}`,
        ]),
      ]));
    });
    return panel;
  }

  /** "나" 패널 하단에 표시되는 메시지 + 진화 버튼 블록. */
  private renderMyActionFeedback(): HTMLElement {
    const wrap = el("div", { class: "my-feedback" });

    // Cheat mode: 추천 수 패널
    if (this.cheatEnabled && this.phase === "human-action" && !this.state.ended) {
      wrap.append(this.buildCheatPanel());
    }

    // Analysis mode: 내 행동 채점 로그(최근 5건, 최신이 아래)
    if (this.analysisEnabled && this.analysisLog.length > 0) {
      const panel = el("div", { class: "analysis-panel" });
      panel.append(el("div", { class: "analysis-title" }, ["📊 분석 — 내 수 평가"]));
      for (const line of this.analysisLog) {
        panel.append(el("div", { class: "analysis-row" }, [line]));
      }
      wrap.append(panel);
    }

    // Message
    if (this.msg.text && this.phase !== "ai") {
      const alertCls = this.msg.kind === "ok" ? "alert-success" :
        this.msg.kind === "bad" ? "alert-error" : "alert-info";
      wrap.append(el("div", { class: `alert ${alertCls} py-2 px-3 text-sm` }, [
        el("span", {}, [this.msg.text]),
      ]));
    }

    // Evolve phase
    if (this.phase === "human-evolve") {
      const evos = legalEvolutions(this.state);
      if (evos.length > 0) {
        const evoWrap = el("div", { class: "flex flex-col gap-1" });
        evoWrap.append(el("div", { class: "text-xs opacity-60" }, [
          el("i", { class: "fa-solid fa-wand-magic-sparkles mr-1" }),
          "진화 가능!",
        ]));
        for (const evo of evos) {
          const s = cardOf(evo.sourceId);
          const t = cardOf(evo.targetId);
          evoWrap.append(el("button", {
            class: "btn btn-sm btn-warning",
            onclick: () => this.humanEvolve(evo),
          }, [
            el("i", { class: "fa-solid fa-wand-magic-sparkles mr-1" }),
            `${s.name} → ${t.name} (+${t.points - s.points}점)`,
          ]));
        }
        evoWrap.append(el("button", {
          class: "btn btn-sm btn-ghost",
          onclick: () => this.humanEvolve(null),
        }, ["건너뛰기"]));
        wrap.append(evoWrap);
      }
    }

    return wrap;
  }

  private renderAiPanel(index: number): HTMLElement {
    const p = this.state.players[index]!;
    const cls = ["ai-panel"];
    if (index === this.state.currentPlayer && !this.state.ended) cls.push("current-turn");

    const panel = el("div", { class: cls.join(" ") });

    // Name + points
    panel.append(el("div", { class: "flex items-center justify-between" }, [
      el("div", { class: "flex items-center gap-2" }, [
        el("div", { class: "avatar placeholder" }, [
          el("div", { class: "bg-neutral text-neutral-content w-6 rounded-full" }, [
            el("i", { class: "fa-solid fa-robot text-xs" }),
          ]),
        ]),
        el("span", { class: "ai-name" }, [this.playerName(index)]),
      ]),
      el("div", { class: "flex items-center gap-2" }, [
        el("span", { class: "ai-pts" }, [`${playerPoints(p)}점`]),
        el("span", { class: "badge badge-xs badge-ghost" }, [`진화 ${p.evolutions}`]),
      ]),
    ]));

    // Balls + color totals compact
    const row = el("div", { class: "ai-row" });
    for (const c of COLORS) {
      if (p.balls[c] > 0) row.append(ballChip(c, p.balls[c]));
    }
    if (p.balls.gold > 0) row.append(ballChip("gold", p.balls.gold));
    panel.append(row);

    const totalRow = el("div", { class: "ai-row" });
    const hasTotal = COLORS.some((c) => this.colorTotal(p, c) > 0);
    if (hasTotal) totalRow.append(el("span", { class: "ai-row-label" }, ["총점수"]));
    for (const c of COLORS) {
      const total = this.colorTotal(p, c);
      if (total > 0) totalRow.append(colorCountBadge(c, total, this.colorTotalTitle(p, c)));
    }
    if (hasTotal) panel.append(totalRow);

    // Scored cards grouped by bonus color
    if (p.scored.length > 0) {
      panel.append(this.renderScoredStacks(p.scored, 36, false));
    }

    // Reserved cards are public in this simulator so the user can track AI plans.
    if (p.reserved.length > 0) {
      const reservedRow = el("div", { class: "ai-card-row ai-reserved-row" }, [
        el("span", { class: "ai-row-label" }, [`보관 ${p.reserved.length}/${MAX_RESERVED}`]),
      ]);
      for (const id of p.reserved) {
        const card = cardOf(id);
        const mc = makeMiniCard(card, { size: 36 });
        mc.addEventListener("mouseenter", () => showTooltip(mc, card));
        mc.addEventListener("mouseleave", () => hideTooltip());
        reservedRow.append(mc);
      }
      panel.append(reservedRow);
    }

    return panel;
  }

  private renderActionPanel(): HTMLElement {
    // AI turn indicator (메시지/진화 UI는 "나" 패널 아래로 이동됨)
    if (!this.isHumanTurn() && this.phase === "ai") {
      const panel = el("div", { class: "player-panel" });
      panel.append(el("div", { class: "alert alert-info py-2 px-3 text-sm" }, [
        el("span", {}, [
          el("i", { class: "fa-solid fa-spinner fa-spin mr-1" }),
          `${this.playerName(this.state.currentPlayer)} 생각 중입니다…`,
        ]),
      ]));
      return panel;
    }

    // 유저 턴에는 빈 패널을 그리지 않음 (공간 절약)
    return el("div", { class: "action-spacer" });
  }

  // ── End game overlay ──

  private renderEndOverlay(): HTMLElement {
    const ranked = rankPlayers(this.state);
    const winner = winnerId(this.state);
    const rows = ranked.map((pid, idx) => {
      const p = this.state.players[pid]!;
      const cls = idx === 0 ? "text-warning font-bold" : "";
      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "4위";
      return el("tr", {}, [
        el("td", { class: cls }, [medal]),
        el("td", { class: cls }, [this.playerName(pid)]),
        el("td", { class: cls }, [`${playerPoints(p)}점`]),
        el("td", { class: cls }, [`${p.evolutions}`]),
        el("td", { class: cls }, [`${p.scored.length}`]),
      ]);
    });
    return el("div", { class: "endgame-overlay" }, [
      el("div", { class: "card bg-base-200 shadow-2xl p-6 max-w-md" }, [
        el("h2", { class: "card-title text-2xl justify-center text-warning mb-4" }, [
          el("i", { class: "fa-solid fa-trophy mr-2" }),
          `${this.playerName(winner)} 승리!`,
        ]),
        el("div", { class: "overflow-x-auto" }, [
          el("table", { class: "table table-sm" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", {}, ["순위"]), el("th", {}, ["플레이어"]), el("th", {}, ["점수"]),
              el("th", {}, ["진화"]), el("th", {}, ["카드"]),
            ])]),
            el("tbody", {}, rows),
          ]),
        ]),
        el("div", { class: "card-actions justify-center mt-4 gap-2" }, [
          el("button", {
            class: "btn btn-warning",
            onclick: () => this.newGame(this.state.numPlayers),
          }, [
            el("i", { class: "fa-solid fa-rotate-right mr-1" }),
            `${this.state.numPlayers}인으로 다시`,
          ]),
          el("button", {
            class: "btn btn-outline",
            onclick: () => this.showSetup(),
          }, [
            el("i", { class: "fa-solid fa-users mr-1" }),
            "인원 변경",
          ]),
        ]),
      ]),
    ]);
  }

  // ── Win rates ──

  private requestWinProb(): void {
    if (this.state.ended) return;
    const snap: Snapshot = serialize(this.state);
    const requestId = ++this.winRateRequestSeq;
    this.activeWinRateRequestId = requestId;
    this.winRatesStale = true;
    this.worker.postMessage({ requestId, snapshot: snap, humanIndex: HUMAN_INDEX, n: MC_N, seed: this.probSeed++ });
  }

  private renderProbs(): void {
    const probsEl = this.root.querySelector(".prob-bars");
    if (!probsEl) return;
    const neu = this.buildProbsBars();
    probsEl.replaceWith(neu);
  }

  private buildProbsBars(): HTMLElement {
    const probs = el("div", { class: "prob-bars" });
    for (let i = 0; i < this.state.numPlayers; i++) {
      const p = this.state.players[i]!;
      const pct = this.winRatesStale ? null : this.winRates[i];
      const cls = ["prob-item", "clickable"];
      if (i === HUMAN_INDEX) cls.push("me");
      if (i === this.state.currentPlayer && !this.state.ended) cls.push("current");
      probs.append(el("div", {
        class: cls.join(" "),
        title: `${this.playerName(i)} ${playerPoints(p)}점 — 클릭 또는 ${i + 1} 키로 보유 현황 보기`,
        onclick: () => this.toggleCardsModal(i),
      }, [
        el("span", { class: "text-xs opacity-70" }, [this.playerName(i)]),
        el("div", { class: "prob-bar-track" }, [
          el("div", { class: "prob-bar-fill", style: pct != null ? `width:${Math.round(pct * 100)}%` : "width:0%" }),
        ]),
        el("span", { class: "text-xs font-bold" }, [pct != null ? `${Math.round(pct * 100)}%` : "…"]),
      ]));
    }
    return probs;
  }
}
