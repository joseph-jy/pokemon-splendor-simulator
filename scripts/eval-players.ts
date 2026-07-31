// 인원수(2·3·4인)별 비교 실험 하네스.
// eval-mcts.ts 가 4인 고정인 것과 달리, 세 가지 실험을 인원수별로 돌린다.
//
//   1) mode=mcts  — MCTS 1명 vs 기존 휴리스틱 AI (n-1)명. 기준선 1/n.
//   2) mode=block — 견제(blockValue) 방식 어블레이션. 후보 1명(견제 모드 변형) vs 기준 AI (n-1)명.
//   3) mode=stats — 기본 AI 자기대국의 인원별 게임 통계(턴 수·행동 분포·tier 분포 등).
//
// 실행:
//   npx vite-node scripts/eval-players.ts -- --mode=mcts  --players=2,3,4 --games=120 --iters=400
//   npx vite-node scripts/eval-players.ts -- --mode=block --players=2,3,4 --games=480
//   npx vite-node scripts/eval-players.ts -- --mode=stats --players=2,3,4 --games=300
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { COLORS, isNoble } from "@/game/types";
import { cardOf, createGame, playerPoints } from "@/game/state";
import { applyEvolution, applyMainAction, finishTurn, rankPlayers, winnerId } from "@/game/engine";
import { WEIGHTS, type StrategyWeights } from "@/strategy/weights";
import { DEFAULT_MCTS, chooseMctsTurn, type MctsOptions } from "@/strategy/mcts";
import { chooseStrongTurn } from "@/strategy/policy";
import { ci95, playAgentSeries, strongAgent, type TurnAgent } from "@/tuning/arena";
import { Rng } from "@/game/rng";

/* ─────────────────────────── 견제(block) 모드 ─────────────────────────── */

/**
 * 2026-07-31 CEM 재튜닝 이전의 기본 가중치.
 * 튜닝은 휴리스틱(`chooseStrongTurn`) 적합도로 돌렸지만 MCTS 도 같은 벡터를 롤아웃·후보 평가에 쓴다.
 * "튜닝 벡터가 MCTS 에는 해로운가"를 분리 측정하려면 MCTS 좌석에만 이 벡터를 주면 된다
 * (`--mode=mcts --mctsw=prev`).
 */
const PRE_TUNE_WEIGHTS: StrategyWeights = {
  pts: 1.0, bonus: 0.6, evo: 1.5, goal: 0.5, cost: 1.0, tiebreak: 0.4,
  reserve: 0.45, master: 0.8, blind: 0.15, ballGoal: 0.55, ballOff: 0.04,
  costScale: 0.22, take2Bonus: 0.18, pressureEvo: 2.8, pressureMissing: 0.75,
  evalPts: 11, evalBonus: 1.35, evalTempo: 0.65, ptDiff: 8,
  block: 0.65, blockBase: 1.8, blockPts: 0, blockEvo: 0, blockNoble: 0,
  blockLeader: 0, blockNear: 0, blockNearWindow: 2, mixAfter: 0.58,
};

/** 견제 부품을 전부 끈 상태. 각 모드는 여기서 필요한 부품만 켠다(현행 기본값과 무관하게 고정). */
const ZERO = { blockBase: 0, blockPts: 0, blockEvo: 0, blockNoble: 0, blockLeader: 0 } as const;

/** 2026-07-31 어블레이션 이전의 기본 견제 가중치(비교 기준으로 보존). */
const LEGACY = { blockBase: 1.8, blockPts: 4, blockEvo: 3, blockNoble: 2, blockLeader: 1.5 } as const;

/**
 * 견제 어블레이션 모드. 기본 가중치(`full`)에 덮어쓸 값만 적는다.
 * 각 모드는 "어떤 카드를 견제 대상으로 볼 것인가"라는 서로 다른 견제 전략에 대응한다.
 * 부품 값은 리터럴로 고정해 두었으므로 `WEIGHTS` 기본값이 바뀌어도 모드의 의미는 유지된다.
 */
export const BLOCK_MODES: Record<string, { label: string; over: Partial<StrategyWeights> }> = {
  none: { label: "견제 안 함", over: { block: 0 } },
  flat: {
    label: "무차별 선점(상대가 살 수 있는 카드면 점수 무관)",
    over: { ...ZERO, blockBase: LEGACY.blockBase },
  },
  points: { label: "고점 카드만 선점", over: { ...ZERO, blockPts: LEGACY.blockPts } },
  evo: { label: "진화 저격만(상대 다음 진화 단계 카드)", over: { ...ZERO, blockEvo: LEGACY.blockEvo } },
  noble: { label: "희귀·전설만 선점", over: { ...ZERO, blockNoble: LEGACY.blockNoble } },
  leader: { label: "선두(12점 이상) 저격만", over: { ...ZERO, blockLeader: LEGACY.blockLeader } },
  legacy: { label: "구 기본값(점수·진화·등급 가중 포함)", over: { ...LEGACY } },
  full: { label: "현행 기본 가중치 — sanity check", over: {} },
  half: { label: "기본 강도 ×0.5", over: { block: WEIGHTS.block * 0.5 } },
  double: { label: "기본 강도 ×2", over: { block: WEIGHTS.block * 2 } },
  quad: { label: "기본 강도 ×4", over: { block: WEIGHTS.block * 4 } },
  near1: { label: "선제 견제(부족 2볼 이내, 계수 0.5)", over: { blockNear: 0.5 } },
  near2: { label: "선제 견제(부족 2볼 이내, 계수 1.0)", over: { blockNear: 1.0 } },
  near3: { label: "선제 견제(부족 3볼 이내, 계수 1.0)", over: { blockNear: 1.0, blockNearWindow: 3 } },
};

function weightsFor(mode: string): StrategyWeights {
  const entry = BLOCK_MODES[mode];
  if (!entry) throw new Error(`unknown block mode: ${mode}`);
  return { ...WEIGHTS, ...entry.over };
}

/* ─────────────────────────── 게임 통계 ─────────────────────────── */

/** 합산 가능한(숫자만) 통계 누산기. 게임 수로 나눠 평균을 낸다. */
export type StatsAcc = Record<string, number>;

const STAT_KEYS = [
  "games", "turns", "winnerPoints", "loserPointsSum", "loserCount", "tiebreakGames",
  "take1", "take2diff", "take3", "take2same", "reserve", "reserveBlind", "acquire",
  "cardsT1", "cardsT2", "cardsT3", "cardsRare", "cardsLegendary",
  "goldSpent", "evolutions",
  "turnsWithEmptyColor", "ballsHeldSum", "supplyLeftSum",
  "t3Buys", "t3MaxCostSum", "t3BonusAtBuySum",
  "nobleBuys", "nobleTurnSum",
] as const;

function newAcc(): StatsAcc {
  const acc: StatsAcc = {};
  for (const k of STAT_KEYS) acc[k] = 0;
  return acc;
}

function addAcc(a: StatsAcc, b: StatsAcc): StatsAcc {
  const out: StatsAcc = { ...a };
  for (const k of Object.keys(b)) out[k] = (out[k] ?? 0) + b[k]!;
  return out;
}

/** 기본 AI 자기대국 1판을 돌리며 통계를 누적한다. */
function playStatsMatch(numPlayers: number, seed: number, acc: StatsAcc, maxTurns = 400): void {
  const s = createGame(seed, numPlayers);
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
  let turns = 0;
  while (!s.ended && turns < maxTurns) {
    // 턴 시작 시점의 공급 상태
    let empty = 0;
    let supplyLeft = 0;
    for (const c of COLORS) {
      supplyLeft += s.supply[c];
      if (s.supply[c] === 0) empty++;
    }
    acc.supplyLeftSum! += supplyLeft;
    if (empty > 0) acc.turnsWithEmptyColor! += 1;
    const actor = s.players[s.currentPlayer]!;
    for (const c of COLORS) acc.ballsHeldSum! += actor.balls[c];
    acc.ballsHeldSum! += actor.balls.gold;

    const pick = chooseStrongTurn(s, rng, WEIGHTS);
    if (pick) {
      const a = pick.action;
      switch (a.type) {
        case "take3":
          if (a.colors.length === 1) acc.take1! += 1;
          else if (a.colors.length === 2) acc.take2diff! += 1;
          else acc.take3! += 1;
          break;
        case "take2": acc.take2same! += 1; break;
        case "reserve": acc.reserve! += 1; break;
        case "reserveBlind": acc.reserveBlind! += 1; break;
        case "acquire": {
          acc.acquire! += 1;
          const card = cardOf(a.cardId);
          acc.goldSpent! += a.pay.gold;
          if (card.tier === 1) acc.cardsT1! += 1;
          else if (card.tier === 2) acc.cardsT2! += 1;
          else if (card.tier === 3) acc.cardsT3! += 1;
          else if (card.tier === "rare") acc.cardsRare! += 1;
          else acc.cardsLegendary! += 1;
          if (card.tier === 3) {
            // 3단계 카드의 최대 단색 요구량 vs 구매 시점의 그 색 보너스
            let maxColor = COLORS[0]!;
            let maxCost = 0;
            for (const c of COLORS) {
              const v = card.cost[c] ?? 0;
              if (v > maxCost) { maxCost = v; maxColor = c; }
            }
            acc.t3Buys! += 1;
            acc.t3MaxCostSum! += maxCost;
            acc.t3BonusAtBuySum! += actor.bonus[maxColor];
          }
          if (isNoble(card.tier)) {
            acc.nobleBuys! += 1;
            acc.nobleTurnSum! += Math.floor(turns / numPlayers);
          }
          break;
        }
      }
      applyMainAction(s, pick.action);
      if (pick.evolution) applyEvolution(s, pick.evolution);
    }
    finishTurn(s);
    turns++;
  }

  const winner = winnerId(s);
  const winnerPts = playerPoints(s.players[winner]!);
  let tied = 0;
  for (const p of s.players) {
    if (p.id === winner) continue;
    const pts = playerPoints(p);
    acc.loserPointsSum! += pts;
    acc.loserCount! += 1;
    if (pts === winnerPts) tied++;
    acc.evolutions! += p.evolutions;
  }
  acc.evolutions! += s.players[winner]!.evolutions;
  acc.games! += 1;
  acc.turns! += turns;
  acc.winnerPoints! += winnerPts;
  if (tied > 0) acc.tiebreakGames! += 1;
}

/* ─────────────────────────── 잡 실행 ─────────────────────────── */

interface Job {
  kind: "mcts" | "block" | "stats";
  players: number;
  games: number;
  seedBase: number;
  iters?: number;
  mode?: string;
  /** mcts 모드 전용: MCTS 좌석이 쓸 가중치("prev" = 재튜닝 이전 벡터). */
  mctsw?: string;
  /** block 모드 전용: 나머지 좌석이 쓸 견제 모드(기본 full = 기본 가중치). */
  baseMode?: string;
}

interface JobResult {
  wins: number;
  games: number;
  rankSum: number;
  acc?: StatsAcc;
}

function mctsAgent(opts: MctsOptions, w: StrategyWeights = WEIGHTS): TurnAgent {
  return (s, rng) => {
    const pick = chooseMctsTurn(s, rng, w, opts);
    return pick ? { action: pick.action, evolution: pick.evolution } : null;
  };
}

function runJob(job: Job): JobResult {
  if (job.kind === "stats") {
    const acc = newAcc();
    for (let g = 0; g < job.games; g++) {
      playStatsMatch(job.players, (job.seedBase + g * 7919) >>> 0, acc);
    }
    return { wins: 0, games: job.games, rankSum: 0, acc };
  }
  const candidate: TurnAgent = job.kind === "mcts"
    ? mctsAgent(
        { ...DEFAULT_MCTS, iterations: job.iters ?? DEFAULT_MCTS.iterations },
        job.mctsw === "prev" ? PRE_TUNE_WEIGHTS : WEIGHTS,
      )
    : strongAgent(weightsFor(job.mode!));
  const baseline = strongAgent(job.kind === "block" ? weightsFor(job.baseMode ?? "full") : WEIGHTS);
  const r = playAgentSeries(candidate, baseline, job.games, job.players, job.seedBase);
  return { wins: r.wins, games: r.games, rankSum: r.rankScore * r.games };
}

function runJobs(jobs: Job[]): JobResult[] {
  return jobs.map(runJob);
}

const TMP_DIR = resolve(process.cwd(), "tuning-results", ".tmp");
const VITE_NODE = resolve(process.cwd(), "node_modules", ".bin", "vite-node");

/** 잡을 라운드로빈으로 샤딩해 자식 프로세스로 병렬 실행. */
async function runJobsParallel(jobs: Job[], workers: number, tag: string): Promise<JobResult[]> {
  if (workers <= 1 || jobs.length <= 1) return runJobs(jobs);
  mkdirSync(TMP_DIR, { recursive: true });
  const shards: { indices: number[]; jobs: Job[] }[] = Array.from(
    { length: Math.min(workers, jobs.length) },
    () => ({ indices: [], jobs: [] }),
  );
  jobs.forEach((job, i) => {
    const s = shards[i % shards.length]!;
    s.indices.push(i);
    s.jobs.push(job);
  });
  const results = new Array<JobResult>(jobs.length);
  await Promise.all(shards.map((shard, si) => new Promise<void>((done, reject) => {
    const file = resolve(TMP_DIR, `players-${tag}-shard${si}.json`);
    writeFileSync(file, JSON.stringify(shard.jobs));
    const child = spawn(VITE_NODE, ["scripts/eval-players.ts", "--", "--worker", `--file=${file}`], {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error(`worker ${si} exit ${code}`)); return; }
      const out = JSON.parse(readFileSync(`${file}.out.json`, "utf8")) as JobResult[];
      shard.indices.forEach((orig, k) => { results[orig] = out[k]!; });
      done();
    });
    child.on("error", reject);
  })));
  return results;
}

/* ─────────────────────────── 메인 ─────────────────────────── */

function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? true;
  }
  return out;
}

/** 잡 리스트를 워커 수만큼 쪼갠다(같은 실험 조건 안에서 시드만 분리). */
function shardJobs(base: Omit<Job, "games" | "seedBase">, games: number, seed: number, workers: number): Job[] {
  const per = Math.max(base.players, Math.ceil(games / workers / base.players) * base.players);
  return Array.from({ length: workers }, (_, s) => ({
    ...base,
    games: per,
    seedBase: (seed + s * 15_485_863 + base.players * 104_729) >>> 0,
  }));
}

interface CellResult {
  players: number;
  mode?: string;
  games: number;
  wins: number;
  winRate: number;
  baseline: number;
  ci95: number;
  rankScore: number;
}

function summarize(players: number, mode: string | undefined, rs: JobResult[]): CellResult {
  const wins = rs.reduce((a, r) => a + r.wins, 0);
  const games = rs.reduce((a, r) => a + r.games, 0);
  const rankScore = rs.reduce((a, r) => a + r.rankSum, 0) / games;
  const winRate = wins / games;
  return { players, mode, games, wins, winRate, baseline: 1 / players, ci95: ci95(winRate, games), rankScore };
}

function fmtCell(c: CellResult): string {
  const delta = (c.winRate - c.baseline) * 100;
  return `${c.players}인 ${c.mode ? `[${c.mode}] ` : ""}승률 ${(c.winRate * 100).toFixed(1)}% ` +
    `±${(c.ci95 * 100).toFixed(1)}%p (기준선 ${(c.baseline * 100).toFixed(0)}%, ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%p) ` +
    `| 순위점수 ${(c.rankScore * 100).toFixed(1)} | ${c.wins}/${c.games}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.worker) {
    const jobs = JSON.parse(readFileSync(String(args.file), "utf8")) as Job[];
    writeFileSync(`${String(args.file)}.out.json`, JSON.stringify(runJobs(jobs)));
    return;
  }

  const mode = String(args.mode ?? "block");
  const players = String(args.players ?? "2,3,4").split(",").map((x) => Number(x.trim()));
  const games = Number(args.games ?? 240);
  const seed = Number(args.seed ?? 20260731);
  const workers = Number(args.jobs ?? Math.max(1, Math.min(10, availableParallelism() - 2)));
  const iters = Number(args.iters ?? DEFAULT_MCTS.iterations);
  const outDir = resolve(process.cwd(), "tuning-results");
  mkdirSync(outDir, { recursive: true });
  const t0 = performance.now();

  if (mode === "stats") {
    console.log(`[stats] players=${players.join(",")} games=${games} workers=${workers}`);
    const out: Record<string, StatsAcc> = {};
    for (const n of players) {
      const jobs = shardJobs({ kind: "stats", players: n }, games, seed, workers);
      const rs = await runJobsParallel(jobs, workers, `stats-p${n}`);
      let acc = newAcc();
      for (const r of rs) acc = addAcc(acc, r.acc!);
      out[String(n)] = acc;
      const g = acc.games!;
      console.log(
        `  ${n}인: ${g}판 | 전체 ${(acc.turns! / g).toFixed(1)}턴(1인당 ${(acc.turns! / g / n).toFixed(1)}) ` +
        `| 승자 ${(acc.winnerPoints! / g).toFixed(1)}점 | 동점tie ${((acc.tiebreakGames! / g) * 100).toFixed(1)}% ` +
        `| take2 ${((acc.take2same! / acc.turns!) * 100).toFixed(1)}% | 3단계 ${(acc.cardsT3! / g).toFixed(2)}장 ` +
        `| 전설·희귀 ${((acc.cardsRare! + acc.cardsLegendary!) / g).toFixed(2)}장`,
      );
    }
    const p = resolve(outDir, `players-stats-seed${seed}.json`);
    writeFileSync(p, JSON.stringify({ config: { games, seed, players }, stats: out }, null, 2));
    console.log(`[done] ${p} (${((performance.now() - t0) / 60_000).toFixed(1)}분)`);
    return;
  }

  const cells: CellResult[] = [];
  let tag = mode;
  if (mode === "mcts") {
    const mctsw = args.mctsw ? String(args.mctsw) : undefined;
    if (mctsw) tag = `mcts-w${mctsw}`;
    console.log(
      `[mcts] players=${players.join(",")} games=${games} iters=${iters} workers=${workers}` +
      (mctsw ? ` mcts가중치=${mctsw}` : ""),
    );
    for (const n of players) {
      const jobs = shardJobs({ kind: "mcts", players: n, iters, mctsw }, games, seed, workers);
      const rs = await runJobsParallel(jobs, workers, `mcts-p${n}`);
      const cell = summarize(n, undefined, rs);
      cells.push(cell);
      console.log(`  ${fmtCell(cell)}`);
    }
  } else {
    const modes = String(args.modes ?? Object.keys(BLOCK_MODES).join(",")).split(",");
    const baseMode = String(args.baseline ?? "full");
    tag = `block-vs-${baseMode}`;
    console.log(
      `[block] players=${players.join(",")} modes=${modes.join(",")} baseline=${baseMode} ` +
      `games=${games} workers=${workers}`,
    );
    for (const n of players) {
      for (const m of modes) {
        const jobs = shardJobs({ kind: "block", players: n, mode: m, baseMode }, games, seed, workers);
        const rs = await runJobsParallel(jobs, workers, `block-p${n}-${m}`);
        const cell = summarize(n, m, rs);
        cells.push(cell);
        console.log(`  ${fmtCell(cell)}  ${BLOCK_MODES[m]!.label}`);
      }
    }
  }

  const p = resolve(outDir, `players-${tag}-seed${seed}.json`);
  writeFileSync(p, JSON.stringify({
    config: { mode: tag, games, seed, players, iters: mode === "mcts" ? iters : undefined },
    cells,
  }, null, 2));
  console.log(`[done] ${p} (${((performance.now() - t0) / 60_000).toFixed(1)}분)`);
}

void main();
