import type { CardDef, Color, Tier } from "@/game/types";
import { COLORS, isNoble } from "@/game/types";
import type { GameState, PlayerState } from "@/game/state";
import {
  createGame, playerPoints, handBallCount, canAfford, cardOf, discountedCost,
} from "@/game/state";
import { legalEvolutions, legalMainActions, type MainAction, type Evolution } from "@/game/actions";
import { applyMainAction, applyEvolution, finishTurn, winnerId, rankPlayers } from "@/game/engine";
import { chooseTurn } from "@/strategy/policy";
import { serialize, type Snapshot } from "@/game/snapshot";
import type { WinRates } from "@/simulator/montecarlo";
import { Rng } from "@/game/rng";
import { COLOR_DISPLAY, MAX_RESERVED } from "@/data/balls";
import SimWorker from "@/simulator/worker?worker&inline";
import { el, ballIcon, makeCardEl, makeMiniCard, bonusBadge, showTooltip, hideTooltip, aiLogEl } from "./view";

const HUMAN_INDEX = 0;
const MC_N = 200;
const AI_DELAY_MS = 450;

type Phase = "human-action" | "human-evolve" | "ai" | "ended";

interface UIMsg { kind: "info" | "ok" | "bad"; text: string }

export class Controller {
  private root: HTMLElement;
  private state!: GameState;
  private worker: Worker;
  private phase: Phase = "human-action";
  private msg: UIMsg = { kind: "info", text: "" };
  private winRates: number[] = [];
  private winRatesStale = true;
  private aiRng = new Rng(98765);
  private probSeed = 1;
  private aiLog: string[] = [];
  private ballPickColors: Color[] = [];
  private ballPickActive = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.worker = new SimWorker();
    this.worker.onmessage = (e: MessageEvent<WinRates>) => {
      this.winRates = e.data.rates;
      this.winRatesStale = false;
      this.renderProbs();
    };
  }

  newGame(seed = (Math.random() * 1e9) | 0): void {
    this.state = createGame(seed, 4, HUMAN_INDEX);
    this.phase = "human-action";
    this.msg = { kind: "info", text: `새 게임 시작 (시드 ${seed}). 선공: ${this.playerName(this.state.startingPlayer)}.` };
    this.winRates = new Array(4).fill(0.25);
    this.winRatesStale = true;
    this.probSeed = (Math.random() * 1e9) | 0;
    this.aiLog = [];
    this.ballPickColors = [];
    this.ballPickActive = false;
    this.render();
    this.startTurn();
  }

  // ── Helpers ──

  private playerName(i: number): string {
    return i === HUMAN_INDEX ? "나" : `AI ${i}`;
  }

  private isHumanTurn(): boolean {
    return this.state.currentPlayer === HUMAN_INDEX;
  }

  private setMsg(m: UIMsg): void {
    this.msg = m;
  }

  // ── Turn flow ──

  private startTurn(): void {
    if (this.state.ended) { this.phase = "ended"; this.render(); return; }
    if (this.isHumanTurn()) {
      this.phase = "human-action";
      this.ballPickColors = [];
      this.ballPickActive = false;
      this.setMsg({ kind: "info", text: "내 차례 — 행동을 선택하세요." });
      this.render();
    } else {
      this.phase = "ai";
      this.setMsg({ kind: "info", text: `${this.playerName(this.state.currentPlayer)} 차례…` });
      this.render();
      setTimeout(() => this.aiMove(), AI_DELAY_MS);
    }
  }

  private aiMove(): void {
    if (this.state.ended) { this.startTurn(); return; }
    const pick = chooseTurn(this.state, "ai", this.aiRng);
    if (!pick) { this.advance(); return; }
    const aiIdx = this.state.currentPlayer;
    const desc = this.describeAction(aiIdx, pick.action);
    applyMainAction(this.state, pick.action);
    if (pick.evolution) applyEvolution(this.state, pick.evolution);
    this.pushAiLog(desc);
    this.advance();
  }

  private advance(): void {
    finishTurn(this.state);
    this.requestWinProb();
    this.startTurn();
  }

  // ── AI log ──

  private pushAiLog(desc: string): void {
    this.aiLog.push(desc);
    if (this.aiLog.length > 5) this.aiLog.shift();
  }

  private describeAction(playerIdx: number, action: MainAction): string {
    switch (action.type) {
      case "acquire": {
        const card = cardOf(action.cardId);
        return `AI ${playerIdx}: ${card.name} 획득`;
      }
      case "reserve": {
        const card = cardOf(action.cardId);
        return `AI ${playerIdx}: ${card.name} 보관`;
      }
      case "take3":
        return `AI ${playerIdx}: ${action.colors.map((c) => COLOR_DISPLAY[c]).join("+")} 획득`;
      case "take2":
        return `AI ${playerIdx}: ${COLOR_DISPLAY[action.color]} 2개 획득`;
      case "reserveBlind":
        return `AI ${playerIdx}: ${action.tier}단계 더미 보관`;
    }
  }

  // ── Human action handling ──

  private humanPlay(action: MainAction): void {
    if (this.phase !== "human-action") return;
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
    if (evo) applyEvolution(this.state, evo);
    this.advance();
  }

  // ── Ball pick flow ──

  private startBallPick(): void {
    this.ballPickActive = true;
    this.ballPickColors = [];
    this.render();
  }

  private toggleBallColor(c: Color): void {
    if (!this.ballPickActive) return;
    const idx = this.ballPickColors.indexOf(c);
    if (idx >= 0) {
      this.ballPickColors.splice(idx, 1);
    } else if (this.ballPickColors.length < 3) {
      this.ballPickColors.push(c);
    }
    this.render();
  }

  private confirmBallPick(): void {
    if (this.ballPickColors.length === 0) return;
    const picked = [...this.ballPickColors].sort();
    const match = legalMainActions(this.state).find((a) => {
      if (a.type !== "take3") return false;
      const ac = [...a.colors].sort();
      return ac.length === picked.length && ac.every((v, i) => v === picked[i]);
    });
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
    // Always try acquire
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

  // ── Render ──

  render(): void {
    this.root.replaceChildren(
      this.renderHeader(),
      this.aiPanelEl(2, "top"),
      this.aiPanelEl(1, "left"),
      this.renderBoard(),
      this.aiPanelEl(3, "right"),
      this.mePanelEl(),
    );
    // End game overlay on top
    if (this.state.ended) {
      this.root.append(this.renderEndOverlay());
    }
  }

  // ── Header ──

  private renderHeader(): HTMLElement {
    const probs = el("div", { class: "probs-inline" });
    for (let i = 0; i < this.state.numPlayers; i++) {
      const p = this.state.players[i]!;
      const pct = this.winRatesStale ? null : this.winRates[i];
      const cls = ["prob-bar"];
      if (i === HUMAN_INDEX) cls.push("me");
      if (i === this.state.currentPlayer && !this.state.ended) cls.push("current");
      probs.append(el("div", { class: cls.join(" "), title: `${this.playerName(i)} ${playerPoints(p)}점` }, [
        el("span", { class: "prob-name" }, [this.playerName(i)]),
        el("div", { class: "bar" }, [
          el("div", { style: pct != null ? `width:${Math.round(pct * 100)}%` : "width:0%" }),
        ]),
        el("span", { class: "prob-pct" }, [pct != null ? `${Math.round(pct * 100)}%` : "…"]),
      ]));
    }

    const turnText = this.state.ended ? "게임 종료" : `${this.playerName(this.state.currentPlayer)} 차례`;

    const logEl = aiLogEl();
    for (const entry of this.aiLog) {
      logEl.append(el("div", {}, [entry]));
    }

    const newGameBtn = el("button", { class: "btn-sm", onclick: () => this.newGame() }, ["새 게임"]);

    return el("div", { class: "area-header" }, [
      el("span", { class: "header-title" }, ["포켓몬 스플렌더"]),
      probs,
      el("div", { class: "header-right" }, [
        el("span", { class: "turn-indicator" }, [turnText]),
        logEl,
        newGameBtn,
      ]),
    ]);
  }

  // ── AI panels ──

  private aiPanelEl(index: number, position: "top" | "left" | "right"): HTMLElement {
    const p = this.state.players[index]!;
    const areaCls = position === "top" ? "area-top" : position === "left" ? "area-left" : "area-right";
    const cls = ["ai-panel", `ai-panel-${position}`, areaCls];
    if (index === this.state.currentPlayer && !this.state.ended) cls.push("current");

    const nameRow = el("div", { class: "ai-name" }, [
      el("span", { class: "pname" }, [`AI ${index}`]),
      el("span", { class: "ppt" }, [`${playerPoints(p)}점`]),
      el("span", { class: "evo-count" }, [`진화 ${p.evolutions}`]),
    ]);

    // Balls
    const ballsRow = el("div", { class: "ai-balls" });
    for (const c of COLORS) {
      if (p.balls[c] > 0) {
        ballsRow.append(el("span", { class: "ball-chip", title: COLOR_DISPLAY[c] }, [ballIcon(c, 14), String(p.balls[c])]));
      }
    }
    if (p.balls.gold > 0) {
      ballsRow.append(el("span", { class: "ball-chip", title: COLOR_DISPLAY.gold }, [ballIcon("gold", 14), String(p.balls.gold)]));
    }

    // Bonuses
    const bonusRow = el("div", { class: "ai-bonus" });
    for (const c of COLORS) {
      if (p.bonus[c] > 0) bonusRow.append(bonusBadge(c, p.bonus[c]));
    }

    // Scored cards (mini thumbnails)
    const scoredRow = el("div", { class: "ai-scored" });
    for (const id of p.scored) {
      const card = cardOf(id);
      const mc = makeMiniCard(card, { size: 36 });
      mc.addEventListener("mouseenter", () => showTooltip(mc, card));
      mc.addEventListener("mouseleave", () => hideTooltip());
      scoredRow.append(mc);
    }

    return el("div", { class: cls.join(" ") }, [
      nameRow,
      ballsRow,
      bonusRow,
      scoredRow,
    ]);
  }

  // ── Board ──

  private renderBoard(): HTMLElement {
    const board = el("div", { class: "area-board" });

    // Supply bar at top of board
    board.append(this.renderSupplyBar());

    // Card rows
    const rows: [string, Tier][] = [
      ["1단계", 1], ["2단계", 2], ["3단계", 3],
    ];
    for (const [label, tier] of rows) {
      const rowWrap = el("div", { class: "board-row" });
      rowWrap.append(el("span", { class: "tier-label" }, [label]));

      const cards = el("div", { class: "cards" });
      for (const id of this.state.board[tier]) cards.append(this.boardCardEl(id));
      rowWrap.append(cards);

      // Blind reserve button
      if (this.isHumanTurn() && this.phase === "human-action") {
        const blinds = legalMainActions(this.state).filter(
          (a): a is Extract<MainAction, { type: "reserveBlind" }> => a.type === "reserveBlind" && a.tier === tier,
        );
        if (blinds.length > 0) {
          const btn = el("button", {
            class: "btn-blind-reserve",
            onclick: () => this.humanPlay(blinds[0]!),
          }, ["더미 보관"]);
          rowWrap.append(btn);
        }
      }
      board.append(rowWrap);
    }

    // Noble row
    const nobleRow = el("div", { class: "board-row" });
    nobleRow.append(el("span", { class: "tier-label" }, ["희귀/전설"]));
    const nobleCards = el("div", { class: "cards" });
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
      const cls = ["ball-supply"];
      if (picked) cls.push("picked");
      if (myTurn && supply > 0) cls.push("pickable");

      const ballEl = el("div", { class: cls.join(" ") }, [
        ballIcon(c, 22),
        el("span", { class: "cnt" }, [String(supply)]),
      ]);

      if (myTurn && supply > 0) {
        ballEl.addEventListener("click", () => {
          if (!this.ballPickActive) this.startBallPick();
          this.toggleBallColor(c);
        });
      }

      wrap.append(ballEl);
    }

    // Gold (not pickable)
    const goldSupply = this.state.supply.gold;
    wrap.append(el("div", { class: "ball-supply" }, [
      ballIcon("gold", 22),
      el("span", { class: "cnt" }, [String(goldSupply)]),
    ]));

    // Ball pick controls
    if (this.ballPickActive) {
      const controls = el("div", { class: "ball-pick-controls" });

      // Selected colors display
      const sel = el("span", { class: "pick-label" }, [
        "선택: ",
        ...this.ballPickColors.map((c) => COLOR_DISPLAY[c]).join(", "),
      ]);
      controls.append(sel);

      // Confirm button
      const confirmBtn = el("button", {
        class: "btn-sm btn-confirm",
        onclick: () => this.confirmBallPick(),
      }, ["확인"]);
      if (this.ballPickColors.length === 0) confirmBtn.setAttribute("disabled", "");
      controls.append(confirmBtn);

      // Cancel button
      controls.append(el("button", {
        class: "btn-sm btn-cancel",
        onclick: () => this.cancelBallPick(),
      }, ["취소"]));

      wrap.append(controls);
    }

    // Take2 buttons
    if (myTurn && !this.ballPickActive) {
      const legal = legalMainActions(this.state);
      const take2s = legal.filter((a): a is Extract<MainAction, { type: "take2" }> => a.type === "take2");
      if (take2s.length > 0) {
        const t2wrap = el("div", { class: "take2-buttons" });
        for (const a of take2s) {
          t2wrap.append(el("button", {
            class: "btn-sm btn-take2",
            onclick: () => this.humanPlay(a),
          }, [`${COLOR_DISPLAY[a.color]} 2개`]));
        }
        wrap.append(t2wrap);
      }
    }

    // Start ball pick hint
    if (myTurn && !this.ballPickActive) {
      const legal = legalMainActions(this.state);
      const hasTake3 = legal.some((a) => a.type === "take3");
      if (hasTake3) {
        wrap.append(el("span", {
          class: "pick-hint",
          onclick: () => this.startBallPick(),
        }, ["볼 선택 →"]));
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

    const clickable = myTurn && affordable;
    const dim = myTurn && !affordable;
    const showReserveBtn = myTurn && isStage && reserveOk;

    const node = makeCardEl(card, {
      clickable,
      affordable: myTurn && affordable,
      dim,
      reserveBtn: showReserveBtn,
      onclick: clickable ? () => this.onCardClick(id) : undefined,
    });

    // Attach tooltip
    node.addEventListener("mouseenter", () => showTooltip(node, card));
    node.addEventListener("mouseleave", () => hideTooltip());

    // Wire reserve button
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

  // ── Bottom panel (Me) ──

  private mePanelEl(): HTMLElement {
    const p = this.state.players[HUMAN_INDEX]!;
    const cls = ["area-bottom"];
    if (this.state.currentPlayer === HUMAN_INDEX && !this.state.ended) cls.push("current");

    const panel = el("div", { class: cls.join(" ") });

    // Section 1: Balls + Bonuses
    const ballsSection = el("div", { class: "me-section me-balls" });
    ballsSection.append(el("div", { class: "me-section-title" }, ["볼·보너스"]));

    const ballsRow = el("div", { class: "me-ball-row" });
    for (const c of COLORS) {
      if (p.balls[c] > 0) {
        ballsRow.append(el("span", { class: "ball-chip", title: COLOR_DISPLAY[c] }, [ballIcon(c, 18), String(p.balls[c])]));
      }
    }
    if (p.balls.gold > 0) {
      ballsRow.append(el("span", { class: "ball-chip", title: COLOR_DISPLAY.gold }, [ballIcon("gold", 18), String(p.balls.gold)]));
    }
    ballsSection.append(ballsRow);

    const bonusRow = el("div", { class: "me-bonus-row" });
    for (const c of COLORS) {
      if (p.bonus[c] > 0) bonusRow.append(bonusBadge(c, p.bonus[c]));
    }
    ballsSection.append(bonusRow);
    ballsSection.append(el("div", { class: "me-stats" }, [`보유볼 ${handBallCount(p)} · 진화 ${p.evolutions}`]));
    panel.append(ballsSection);

    // Section 2: Scored cards
    const scoredSection = el("div", { class: "me-section me-scored" });
    scoredSection.append(el("div", { class: "me-section-title" }, [`획득 (${p.scored.length})`]));
    const scoredScroll = el("div", { class: "me-card-scroll" });
    for (const id of p.scored) {
      const card = cardOf(id);
      const mc = makeMiniCard(card, { size: 48, label: true });
      mc.addEventListener("mouseenter", () => showTooltip(mc, card));
      mc.addEventListener("mouseleave", () => hideTooltip());
      scoredScroll.append(mc);
    }
    scoredSection.append(scoredScroll);
    panel.append(scoredSection);

    // Section 3: Reserved cards
    const reservedSection = el("div", { class: "me-section me-reserved" });
    reservedSection.append(el("div", { class: "me-section-title" }, [`보관 (${p.reserved.length})`]));
    const reservedScroll = el("div", { class: "me-card-scroll" });
    for (const id of p.reserved) {
      const card = cardOf(id);
      const affordable = canAfford(p, card);
      const myTurn = this.isHumanTurn() && this.phase === "human-action";
      const mc = makeMiniCard(card, {
        size: 48,
        label: true,
        affordable: myTurn && affordable,
        onclick: myTurn && affordable ? () => this.onReservedCardClick(id) : undefined,
      });
      mc.addEventListener("mouseenter", () => showTooltip(mc, card));
      mc.addEventListener("mouseleave", () => hideTooltip());
      reservedScroll.append(mc);
    }
    reservedSection.append(reservedScroll);
    panel.append(reservedSection);

    // Section 4: Actions / Messages
    const actionSection = el("div", { class: "me-section me-actions" });
    actionSection.append(el("div", { class: "me-section-title" }, ["행동"]));

    // Show message
    if (this.msg.text) {
      actionSection.append(el("div", { class: `msg ${this.msg.kind}` }, [this.msg.text]));
    }

    // Evolve phase
    if (this.phase === "human-evolve") {
      const evos = legalEvolutions(this.state);
      if (evos.length > 0) {
        const evoBtns = el("div", { class: "evo-buttons" });
        for (const evo of evos) {
          const s = cardOf(evo.sourceId);
          const t = cardOf(evo.targetId);
          evoBtns.append(el("button", {
            class: "btn-sm btn-evo",
            onclick: () => this.humanEvolve(evo),
          }, [`${s.name}→${t.name} (+${t.points - s.points}점)`]));
        }
        evoBtns.append(el("button", {
          class: "btn-sm",
          onclick: () => this.humanEvolve(null),
        }, ["건너뛰기"]));
        actionSection.append(evoBtns);
      }
    }

    // AI turn indicator
    if (!this.isHumanTurn() && this.phase === "ai") {
      actionSection.append(el("div", { class: "msg info" }, ["AI 플레이어가 생각 중입니다…"]));
    }

    panel.append(actionSection);

    return panel;
  }

  // ── End game overlay ──

  private renderEndOverlay(): HTMLElement {
    const ranked = rankPlayers(this.state);
    const winner = winnerId(this.state);
    const rows = ranked.map((pid, idx) => {
      const p = this.state.players[pid]!;
      const cls = idx === 0 ? "rank1" : "";
      return el("tr", {}, [
        el("td", { class: cls }, [idx === 0 ? "🥇" : `${idx + 1}위`]),
        el("td", { class: cls }, [this.playerName(pid)]),
        el("td", { class: cls }, [`${playerPoints(p)}점`]),
        el("td", { class: cls }, [`${p.evolutions}`]),
        el("td", { class: cls }, [`${p.scored.length}`]),
      ]);
    });
    return el("div", { class: "endgame-overlay" }, [
      el("div", { class: "endgame-card" }, [
        el("h2", {}, [`${this.playerName(winner)} 승리!`]),
        el("table", {}, [
          el("thead", {}, [el("tr", {}, [
            el("th", {}, ["순위"]), el("th", {}, ["플레이어"]), el("th", {}, ["점수"]),
            el("th", {}, ["진화"]), el("th", {}, ["카드"]),
          ])]),
          el("tbody", {}, rows),
        ]),
        el("button", {
          class: "btn-sm",
          onclick: () => this.newGame(),
          style: "margin-top:12px",
        }, ["새 게임"]),
      ]),
    ]);
  }

  // ── Win rates ──

  private requestWinProb(): void {
    if (this.state.ended) return;
    const snap: Snapshot = serialize(this.state);
    this.winRatesStale = true;
    this.worker.postMessage({ snapshot: snap, humanIndex: HUMAN_INDEX, n: MC_N, seed: this.probSeed++ });
  }

  private renderProbs(): void {
    const existing = this.root.querySelector(".probs-inline");
    if (!existing) return;
    // Re-render the entire header probs section
    const header = this.root.querySelector(".area-header");
    if (header) {
      const probsInline = header.querySelector(".probs-inline");
      if (probsInline) {
        const neu = this.buildProbsInline();
        probsInline.replaceWith(neu);
      }
    }
  }

  private buildProbsInline(): HTMLElement {
    const probs = el("div", { class: "probs-inline" });
    for (let i = 0; i < this.state.numPlayers; i++) {
      const p = this.state.players[i]!;
      const pct = this.winRatesStale ? null : this.winRates[i];
      const cls = ["prob-bar"];
      if (i === HUMAN_INDEX) cls.push("me");
      if (i === this.state.currentPlayer && !this.state.ended) cls.push("current");
      probs.append(el("div", { class: cls.join(" "), title: `${this.playerName(i)} ${playerPoints(p)}점` }, [
        el("span", { class: "prob-name" }, [this.playerName(i)]),
        el("div", { class: "bar" }, [
          el("div", { style: pct != null ? `width:${Math.round(pct * 100)}%` : "width:0%" }),
        ]),
        el("span", { class: "prob-pct" }, [pct != null ? `${Math.round(pct * 100)}%` : "…"]),
      ]));
    }
    return probs;
  }
}
