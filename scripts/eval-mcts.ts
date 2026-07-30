// MCTS vs 기존 휴리스틱 AI(chooseStrongTurn) 검증 매치(AI_PLAN.md 2단계).
// 실행: npx vite-node scripts/eval-mcts.ts -- [--games=160] [--iters=400] [--seed=7] [--jobs=10] [--bench]
// 4인전: MCTS 1명 vs 기존 AI 3명, 좌석 로테이션. 기준선 25%.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { WEIGHTS } from "@/strategy/weights";
import { DEFAULT_MCTS, chooseMctsTurn, type MctsOptions } from "@/strategy/mcts";
import { ci95, playAgentMatch, playAgentSeries, strongAgent, type TurnAgent } from "@/tuning/arena";
import { Rng } from "@/game/rng";

const NUM_PLAYERS = 4;

function mctsAgent(opts: MctsOptions): TurnAgent {
  return (s, rng) => {
    const pick = chooseMctsTurn(s, rng, WEIGHTS, opts);
    return pick ? { action: pick.action, evolution: pick.evolution } : null;
  };
}

interface Job {
  games: number;
  seedBase: number;
  mcts: MctsOptions;
}

interface JobResult { wins: number; games: number; rankSum: number }

function runJobs(jobs: Job[]): JobResult[] {
  return jobs.map((job) => {
    const r = playAgentSeries(
      mctsAgent(job.mcts), strongAgent(WEIGHTS), job.games, NUM_PLAYERS, job.seedBase,
    );
    return { wins: r.wins, games: r.games, rankSum: r.rankScore * r.games };
  });
}

function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? true;
  }
  return out;
}

const TMP_DIR = resolve(process.cwd(), "tuning-results", ".tmp");
const VITE_NODE = resolve(process.cwd(), "node_modules", ".bin", "vite-node");

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
  await Promise.all(shards.map((shard, si) => new Promise<void>((resolveShard, reject) => {
    const file = resolve(TMP_DIR, `mcts-${tag}-shard${si}.json`);
    writeFileSync(file, JSON.stringify(shard.jobs));
    const child = spawn(VITE_NODE, ["scripts/eval-mcts.ts", "--", "--worker", `--file=${file}`], {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error(`worker ${si} exit ${code}`)); return; }
      const out = JSON.parse(readFileSync(`${file}.out.json`, "utf8")) as JobResult[];
      shard.indices.forEach((orig, k) => { results[orig] = out[k]!; });
      resolveShard();
    });
    child.on("error", reject);
  })));
  return results;
}

function bench(iters: number): void {
  const opts: MctsOptions = { ...DEFAULT_MCTS, iterations: iters };
  const t0 = performance.now();
  const n = 3;
  let turns = 0;
  for (let i = 0; i < n; i++) {
    turns += playAgentMatch(
      [mctsAgent(opts), strongAgent(WEIGHTS), strongAgent(WEIGHTS), strongAgent(WEIGHTS)],
      2000 + i * 7919,
    ).turns;
  }
  const ms = (performance.now() - t0) / n;
  console.log(`[bench] iters=${iters}: ${(ms / 1000).toFixed(1)} s/판, 평균 ${(turns / n).toFixed(1)} 턴`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.worker) {
    const jobs = JSON.parse(readFileSync(String(args.file), "utf8")) as Job[];
    writeFileSync(`${String(args.file)}.out.json`, JSON.stringify(runJobs(jobs)));
    return;
  }
  const iters = Number(args.iters ?? DEFAULT_MCTS.iterations);
  if (args.bench) { bench(iters); return; }

  const games = Number(args.games ?? 160);
  const seed = Number(args.seed ?? 7);
  const workers = Number(args.jobs ?? Math.max(1, Math.min(10, availableParallelism() - 2)));
  const opts: MctsOptions = { ...DEFAULT_MCTS, iterations: iters };

  const perShard = Math.ceil(games / workers / NUM_PLAYERS) * NUM_PLAYERS;
  const jobs: Job[] = Array.from({ length: workers }, (_, s) => ({
    games: perShard,
    seedBase: (seed + s * 15_485_863) >>> 0,
    mcts: opts,
  }));
  console.log(`[eval-mcts] iters=${iters} games=${perShard * workers} workers=${workers} (4인, MCTS 1 vs 기존 AI 3, 기준선 25%)`);
  const t0 = performance.now();
  const rs = await runJobsParallel(jobs, workers, `s${seed}`);
  const wins = rs.reduce((a, r) => a + r.wins, 0);
  const total = rs.reduce((a, r) => a + r.games, 0);
  const rankScore = rs.reduce((a, r) => a + r.rankSum, 0) / total;
  const rate = wins / total;
  const mins = ((performance.now() - t0) / 60_000).toFixed(1);
  console.log(
    `[result] 승률 ${(rate * 100).toFixed(1)}% ±${(ci95(rate, total) * 100).toFixed(1)}%p ` +
    `(기준선 25%, ${wins}/${total}승) | 순위점수 ${(rankScore * 100).toFixed(1)} (기준선 50) | ${mins}분`,
  );

  const outDir = resolve(process.cwd(), "tuning-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `eval-mcts-i${iters}-seed${seed}.json`);
  writeFileSync(outPath, JSON.stringify({
    config: { iters, games: total, seed, mcts: opts },
    result: { winRate: rate, ci95: ci95(rate, total), wins, games: total, rankScore },
  }, null, 2));
  console.log(`[done] 결과 저장: ${outPath}`);
}

void main();
