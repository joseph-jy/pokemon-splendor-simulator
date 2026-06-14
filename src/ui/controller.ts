import type { BallColor, CardDef, Color, Tier } from "@/game/types";
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
import { BALLS_BY_ID, MAX_RESERVED } from "@/data/balls";
import SimWorker from "@/simulator/worker?worker&inline";
import { el, ballIcon, makeCardEl, bonusBadge } from "./view";
import { cardImg } from "./assets";

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
  private mode: "acquire" | "reserve" = "acquire";
  private msg: UIMsg = { kind: "info", text: "" };
  private winRates: number[] = [];
  private winRatesStale = true;
  private aiRng = new Rng(98765);
  private probSeed = 1;

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
    this.mode = "acquire";
    this.msg = { kind: "info", text: `새 게임 시작 (시드 ${seed}). 선공: ${this.playerName(this.state.startingPlayer)}.` };
    this.winRates = new Array(4).fill(0.25);
    this.winRatesStale = true;
    this.probSeed = (Math.random() * 1e9) | 0;
    this.render();
    this.startTurn();
  }

  private playerName(i: number): string {
    return i === HUMAN_INDEX ? "나" : `AI ${i}`;
  }

  private isHumanTurn(): boolean {
    return this.state.currentPlayer === HUMAN_INDEX;
  }

  private startTurn(): void {
    if (this.state.ended) { this.phase = "ended"; this.render(); return; }
    if (this.isHumanTurn()) {
      this.phase = "human-action";
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
    applyMainAction(this.state, pick.action);
    if (pick.evolution) applyEvolution(this.state, pick.evolution);
    this.advance();
  }

  /** 현재 플레이어 턴 종료 → 승률 갱신 요청 → 다음 턴. */
  private advance(): void {
    finishTurn(this.state);
    this.requestWinProb();
    this.startTurn();
  }

  // ── 인간 행동 처리 ──
  private humanPlay(action: MainAction): void {
    if (this.phase !== "human-action") return;
    applyMainAction(this.state, action);
    // 진화 제안
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

  private setMsg(m: UIMsg): void {
    this.msg = m;
  }

  // ── 렌더 ──
  render(): void {
    this.root.replaceChildren(
      this.renderHeader(),
      this.buildProbs(),
      this.renderSupply(),
      this.renderBoard(),
      this.renderPlayers(),
      this.renderActions(),
    );
  }

  private renderHeader(): HTMLElement {
    const restart = el("button", { onclick: () => this.newGame() }, ["새 게임"]);
    return el("header", { class: "top" }, [
      el("h1", {}, ["포켓몬 스플렌더"]),
      el("span", { class: "turn" }, [
        this.state.ended ? "게임 종료" : `${this.playerName(this.state.currentPlayer)} 차례`,
      ]),
      restart,
    ]);
  }

  private buildProbs(): HTMLElement {
    const grid = el("div", { class: "probs" });
    for (let i = 0; i < this.state.numPlayers; i++) {
      const p = this.state.players[i]!;
      const cls = ["prob"];
      if (i === HUMAN_INDEX) cls.push("me");
      if (i === this.state.currentPlayer && !this.state.ended) cls.push("current");
      const pct = this.winRatesStale ? null : this.winRates[i];
      const card = el("div", { class: cls.join(" ") }, [
        el("div", { class: "name" }, [
          el("span", {}, [this.playerName(i)]),
          el("span", { class: "pts" }, [`${playerPoints(p)}점 · 진화 ${p.evolutions}`]),
        ]),
        el("div", { class: "bar" }, [
          el("div", { style: pct != null ? `width:${Math.round(pct * 100)}%` : "width:0%" }),
        ]),
        el("div", { class: "pts" }, [
          pct != null ? `승리 확률 ${Math.round(pct * 100)}%` : "계산 중…",
        ]),
      ]);
      grid.append(card);
    }
    return grid;
  }

  private renderSupply(): HTMLElement {
    const wrap = el("div", { class: "supply" });
    const order: BallColor[] = ["red", "blue", "black", "pink", "yellow", "gold"];
    for (const c of order) {
      wrap.append(el("div", { class: "ball" }, [
        ballIcon(c, 28),
        el("span", { class: "cnt" }, [String(this.state.supply[c])]),
      ]));
    }
    return wrap;
  }

  private renderBoard(): HTMLElement {
    const board = el("div", { class: "board" });
    const rows: [string, Tier][] = [
      ["1단계", 1], ["2단계", 2], ["3단계", 3],
    ];
    for (const [label, tier] of rows) {
      const cards = el("div", { class: "cards" });
      for (const id of this.state.board[tier]) cards.append(this.boardCardEl(id));
      board.append(el("div", { class: "row" }, [
        el("div", { class: "tier-label" }, [label]),
        cards,
      ]));
    }
    // 희귀·전설/환상
    const nobleRow = el("div", { class: "cards" });
    for (const id of this.state.board.rare) nobleRow.append(this.boardCardEl(id));
    for (const id of this.state.board.legendary) nobleRow.append(this.boardCardEl(id));
    board.append(el("div", { class: "row" }, [
      el("div", { class: "tier-label" }, ["희귀/전설"]),
      nobleRow,
    ]));
    return board;
  }

  private boardCardEl(id: string): HTMLElement {
    const card = cardOf(id);
    const myTurn = this.isHumanTurn() && this.phase === "human-action";
    const affordable = canAfford(this.state.players[HUMAN_INDEX]!, card);
    const isStage = card.tier === 1 || card.tier === 2 || card.tier === 3;
    const me = this.state.players[HUMAN_INDEX]!;
    const reserveOk = isStage && me.reserved.length < MAX_RESERVED;
    const clickable = myTurn && (
      (this.mode === "acquire" && affordable) || (this.mode === "reserve" && reserveOk)
    );
    const dim = myTurn && this.mode === "acquire" && !affordable;
    return makeCardEl(card, {
      clickable,
      affordable: myTurn && this.mode === "acquire" && affordable,
      dim,
      badge: this.mode === "reserve" && isStage && reserveOk ? "보관" : undefined,
      onclick: clickable ? () => this.onCardClick(id) : undefined,
    });
  }

  private onCardClick(id: string): void {
    const card = cardOf(id);
    const me = this.state.players[HUMAN_INDEX]!;
    if (this.mode === "acquire") {
      const acts = legalMainActions(this.state).filter((a) => a.type === "acquire" && a.cardId === id);
      const act = acts[0];
      if (act) { this.humanPlay(act); return; }
      this.setMsg({ kind: "bad", text: this.whyNotAfford(me, card) });
      this.render();
    } else {
      const acts = legalMainActions(this.state).filter((a) => a.type === "reserve" && a.cardId === id);
      const act = acts[0];
      if (act) { this.humanPlay(act); return; }
      this.setMsg({ kind: "bad", text: this.whyNotReserve(me, card) });
      this.render();
    }
  }

  private whyNotAfford(p: PlayerState, card: CardDef): string {
    if (isNoble(card.tier) && p.balls.gold < 1) return "획득 불가: 희귀/전설 카드는 마스터볼 1개가 필요합니다.";
    const cost = discountedCost(card, p.bonus);
    const parts: string[] = [];
    for (const c of COLORS) {
      const need = cost[c] ?? 0;
      if (need > p.balls[c]) parts.push(`${BALLS_BY_ID[c].name} ${need - p.balls[c]}개`);
    }
    return parts.length ? `획득 불가: ${parts.join(", ")} 부족` : "획득 불가";
  }

  private whyNotReserve(p: PlayerState, card: CardDef): string {
    if (isNoble(card.tier)) return "보관 불가: 희귀/전설/환상 카드는 보관할 수 없습니다.";
    if (p.reserved.length >= MAX_RESERVED) return `보관 불가: 보관 한도(${MAX_RESERVED}장) 초과`;
    return "보관 불가";
  }

  private renderPlayers(): HTMLElement {
    const grid = el("div", { class: "players" });
    for (let i = 0; i < this.state.numPlayers; i++) {
      grid.append(this.playerEl(i));
    }
    return grid;
  }

  private playerEl(i: number): HTMLElement {
    const p = this.state.players[i]!;
    const cls = ["player"];
    if (i === HUMAN_INDEX) cls.push("me");
    if (i === this.state.currentPlayer && !this.state.ended) cls.push("current");
    const ballsMini = el("div", { class: "balls-mini" });
    for (const c of ["red", "blue", "black", "pink", "yellow"] as Color[]) {
      if (p.balls[c] > 0) ballsMini.append(el("span", { title: BALLS_BY_ID[c].name }, [ballIcon(c, 16), String(p.balls[c])]));
    }
    if (p.balls.gold > 0) ballsMini.append(el("span", { title: "마스터볼" }, [ballIcon("gold", 16), String(p.balls.gold)]));
    const bonusMini = el("div", { class: "bonus-mini" });
    for (const c of COLORS) if (p.bonus[c] > 0) bonusMini.append(bonusBadge(c, p.bonus[c]));
    const scored = el("div", { class: "mini-cards" });
    for (const id of p.scored) scored.append(this.miniCard(id, i));
    const reserved = el("div", { class: "mini-cards" });
    for (const id of p.reserved) reserved.append(this.miniCard(id, i, true));

    return el("div", { class: cls.join(" ") }, [
      el("div", { class: "ph" }, [
        el("span", { class: "pname" }, [`${this.playerName(i)}${i === HUMAN_INDEX ? " (나)" : ""}`]),
        el("span", { class: "ppt" }, [`${playerPoints(p)}점`]),
      ]),
      el("div", { class: "row2" }, [
        el("span", {}, ["볼 "]),
        ballsMini,
        el("span", { style: "margin-left:8px" }, ["보너스 "]),
        bonusMini,
      ]),
      el("div", { class: "row2" }, [`획득 ${p.scored.length}장 · 진화 ${p.evolutions} · 보유볼 ${handBallCount(p)}`]),
      scored,
      p.reserved.length ? el("div", { class: "row2" }, [`보관(${p.reserved.length}): `, ...reserved.childNodes]) : el("div", {}),
    ]);
  }

  private miniCard(id: string, _playerIdx: number, reserved = false): HTMLElement {
    const card = cardOf(id);
    const img = el("img", { src: cardImg(card.tier, card.romanized), alt: card.name, title: `${card.name}${reserved ? " (보관)" : ""}` });
    // 보관 카드 중 내 턴 획득 모드면 클릭 가능
    if (reserved && this.isHumanTurn() && this.phase === "human-action" && this.mode === "acquire" && _playerIdx === HUMAN_INDEX && canAfford(this.state.players[HUMAN_INDEX]!, card)) {
      img.style.cursor = "pointer";
      img.style.outline = "2px solid var(--ok)";
      img.addEventListener("click", () => this.onCardClick(id));
    }
    return img;
  }

  private renderActions(): HTMLElement {
    if (this.state.ended) return this.renderEnd();
    const wrap = el("div", { class: "actions" });
    if (this.msg.text) wrap.append(el("div", { class: `msg ${this.msg.kind}` }, [this.msg.text]));

    if (this.phase === "human-evolve") {
      wrap.append(el("h3", {}, ["진화 선택"]));
      const btns = el("div", { class: "act-buttons" });
      for (const evo of legalEvolutions(this.state)) {
        const s = cardOf(evo.sourceId);
        const t = cardOf(evo.targetId);
        btns.append(el("button", { class: "primary", onclick: () => this.humanEvolve(evo) }, [
          `${s.name} → ${t.name} (+${t.points - s.points}점)`,
        ]));
      }
      btns.append(el("button", { onclick: () => this.humanEvolve(null) }, ["건너뛰기"]));
      wrap.append(btns);
      return wrap;
    }

    if (!this.isHumanTurn() || this.phase !== "human-action") {
      wrap.append(el("div", { class: "msg info" }, ["AI 플레이어가 생각 중입니다…"]));
      return wrap;
    }

    // 모드 토글
    const modeWrap = el("div", { class: "act-group" });
    modeWrap.append(el("div", { class: "lbl" }, ["행동 모드"]));
    const modeBtns = el("div", { class: "act-buttons" });
    modeBtns.append(el("button", {
      class: this.mode === "acquire" ? "primary" : "",
      onclick: () => { this.mode = "acquire"; this.render(); },
    }, ["카드 획득 모드"]));
    modeBtns.append(el("button", {
      class: this.mode === "reserve" ? "primary" : "",
      onclick: () => { this.mode = "reserve"; this.render(); },
    }, ["카드 보관 모드"]));
    modeWrap.append(modeBtns);
    wrap.append(modeWrap);

    // 볼 획득
    const acts = legalMainActions(this.state);
    const ballWrap = el("div", { class: "act-group" });
    ballWrap.append(el("div", { class: "lbl" }, ["볼 획득"]));
    const ballBtns = el("div", { class: "act-buttons" });
    const take3s = acts.filter((a): a is Extract<MainAction, { type: "take3" }> => a.type === "take3");
    const take2s = acts.filter((a): a is Extract<MainAction, { type: "take2" }> => a.type === "take2");
    if (take3s.length) {
      for (const a of take3s.slice(0, 6)) {
        const chips = a.colors.map((c) => `${BALLS_BY_ID[c].name}`).join("+");
        ballBtns.append(el("button", { onclick: () => this.humanPlay(a) }, [`3종: ${chips}`]));
      }
      if (take3s.length > 6) ballBtns.append(el("span", { class: "lbl" }, [`외 ${take3s.length - 6}개 조합 (카드 색 클릭)`]));
    }
    for (const a of take2s) {
      ballBtns.append(el("button", { onclick: () => this.humanPlay(a) }, [`${BALLS_BY_ID[a.color].name} 2개`]));
    }
    if (!take3s.length && !take2s.length) ballBtns.append(el("span", { class: "lbl" }, ["가져올 수 있는 볼이 없습니다."]));
    ballWrap.append(ballBtns);
    wrap.append(ballWrap);

    // 더미 보관
    const blindWrap = el("div", { class: "act-group" });
    blindWrap.append(el("div", { class: "lbl" }, ["더미 맨 위 보관(비공개)"]));
    const blindBtns = el("div", { class: "act-buttons" });
    const blinds = acts.filter((a): a is Extract<MainAction, { type: "reserveBlind" }> => a.type === "reserveBlind");
    for (const a of blinds) {
      blindBtns.append(el("button", { onclick: () => this.humanPlay(a) }, [`${a.tier}단계 더미`]));
    }
    if (!blinds.length) blindBtns.append(el("span", { class: "lbl" }, ["보관 한도 초과 또는 더미 없음"]));
    blindWrap.append(blindBtns);
    wrap.append(blindWrap);

    const hint = el("div", { class: "msg info" }, [
      this.mode === "acquire"
        ? "보드의 카드를 클릭해 획득하세요. 초록 테두리 = 획득 가능."
        : "1·2·3단계 카드를 클릭해 보관하세요(마스터볼 1개 획득).",
    ]);
    wrap.append(hint);
    return wrap;
  }

  private renderEnd(): HTMLElement {
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
    return el("div", { class: "endgame" }, [
      el("h2", {}, [`${this.playerName(winner)} 승리!`]),
      el("table", {}, [
        el("thead", {}, [el("tr", {}, [
          el("th", {}, ["순위"]), el("th", {}, ["플레이어"]), el("th", {}, ["점수"]),
          el("th", {}, ["진화"]), el("th", {}, ["카드"]),
        ])]),
        el("tbody", {}, rows),
      ]),
      el("button", {
        onclick: () => this.newGame(),
        style: "margin-top:12px;padding:8px 18px;border:none;border-radius:8px;background:var(--accent);color:#1a1d2e;font-weight:700;cursor:pointer",
      }, ["새 게임"]),
    ]);
  }

  // ── 승률 갱신 ──
  private requestWinProb(): void {
    if (this.state.ended) return;
    const snap: Snapshot = serialize(this.state);
    this.winRatesStale = true;
    this.worker.postMessage({ snapshot: snap, humanIndex: HUMAN_INDEX, n: MC_N, seed: this.probSeed++ });
    // 종료 상태라면 즉시 확정
  }

  // 부분 갱신: 승률만 다시 그린다.
  private renderProbs(): void {
    const existing = this.root.querySelector(".probs");
    const neu = this.buildProbs();
    if (existing) existing.replaceWith(neu);
  }
}
