// CEM(Cross-Entropy Method) 가중치 튜닝(AI_PLAN.md 1단계).
// 실행: npx vite-node scripts/tune.ts -- [--gens=10] [--pop=16] [--games=24] [--validate=240] [--seed=1] [--jobs=10] [--fitbudget=tune|full] [--bench]
// 확증: npx vite-node scripts/tune.ts -- --confirm=tuning-results/tune-seedN.json --cand=best|mean --games=480 --seed=<새 시드>
// 후보 가중치를 기준(WEIGHTS)과 4인 자기대국시켜 승률(기준선 25%)을 적합도로 최적화한다.
// 속도: 게임당 1~2.5초라서 자식 프로세스(vite-node --worker)로 코어 수만큼 병렬화한다.
// 튜닝 중에는 축소 탐색 예산, 최종 검증은 실제 AI 와 같은 전체 예산.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { WEIGHTS, type StrategyWeights } from "@/strategy/weights";
import { DEFAULT_BUDGET, type SearchBudget } from "@/strategy/policy";
import { ci95, playMatch, playSeries } from "@/tuning/arena";
import { Rng } from "@/game/rng";

const KEYS = Object.keys(WEIGHTS) as (keyof StrategyWeights)[];
const NUM_PLAYERS = 4;

/** 튜닝용 축소 탐색 예산(속도 ↑). 순위 상관은 전체 예산 검증 단계에서 확인. */
const TUNE_BUDGET: SearchBudget = { candidates: 10, rolloutTurns: 10 };

const budgetOf = (kind: "tune" | "full"): SearchBudget =>
  kind === "full" ? DEFAULT_BUDGET : TUNE_BUDGET;

interface Job {
  v: number[];
  games: number;
  seedBase: number;
  budgetKind: "tune" | "full";
}

interface JobResult { wins: number; games: number; rankScore: number }

function toVector(w: StrategyWeights): number[] {
  return KEYS.map((k) => w[k]);
}

function toWeights(v: number[]): StrategyWeights {
  const out = { ...WEIGHTS };
  KEYS.forEach((k, i) => { out[k] = v[i]!; });
  return out;
}

function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? true;
  }
  return out;
}

function runJobs(jobs: Job[]): JobResult[] {
  return jobs.map((job) => {
    const r = playSeries(
      toWeights(job.v), WEIGHTS, job.games, NUM_PLAYERS, job.seedBase, budgetOf(job.budgetKind),
    );
    return { wins: r.wins, games: r.games, rankScore: r.rankScore };
  });
}

/** 워커 모드: 입력 파일의 잡을 순차 실행하고 <file>.out.json 에 결과 기록. */
function workerMain(file: string): void {
  const jobs = JSON.parse(readFileSync(file, "utf8")) as Job[];
  writeFileSync(`${file}.out.json`, JSON.stringify(runJobs(jobs)));
}

const TMP_DIR = resolve(process.cwd(), "tuning-results", ".tmp");
const VITE_NODE = resolve(process.cwd(), "node_modules", ".bin", "vite-node");

/** 잡을 라운드로빈으로 W개 샤드에 나눠 자식 프로세스로 병렬 실행. */
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
    const file = resolve(TMP_DIR, `${tag}-shard${si}.json`);
    writeFileSync(file, JSON.stringify(shard.jobs));
    const child = spawn(VITE_NODE, ["scripts/tune.ts", "--", "--worker", `--file=${file}`], {
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

function bench(): void {
  for (const [label, budget] of [["full", DEFAULT_BUDGET], ["tune", TUNE_BUDGET]] as const) {
    const t0 = performance.now();
    const n = 6;
    let turns = 0;
    for (let i = 0; i < n; i++) {
      turns += playMatch([WEIGHTS, WEIGHTS, WEIGHTS, WEIGHTS], 1000 + i * 7919, budget).turns;
    }
    const ms = (performance.now() - t0) / n;
    console.log(`[bench] ${label}: ${ms.toFixed(0)} ms/판, 평균 ${(turns / n).toFixed(1)} 턴`);
  }
}

/** 확증 매치: 저장된 튜닝 결과의 후보를 새로운 시드로 재검증. */
async function confirmMain(file: string, cand: string, games: number, seed: number, workers: number): Promise<void> {
  const data = JSON.parse(readFileSync(file, "utf8")) as { candidates: Record<string, StrategyWeights> };
  const w = data.candidates[cand];
  if (!w) throw new Error(`unknown candidate: ${cand}`);
  const v = toVector(w);
  const perShard = Math.ceil(games / workers / NUM_PLAYERS) * NUM_PLAYERS;
  const jobs: Job[] = Array.from({ length: workers }, (_, s) => ({
    v,
    games: perShard,
    seedBase: (seed + s * 32_452_843) >>> 0,
    budgetKind: "full",
  }));
  const rs = await runJobsParallel(jobs, workers, `confirm-${cand}`);
  const wins = rs.reduce((a, r) => a + r.wins, 0);
  const total = rs.reduce((a, r) => a + r.games, 0);
  const rate = wins / total;
  console.log(
    `[confirm:${cand}] 승률 ${(rate * 100).toFixed(1)}% ±${(ci95(rate, total) * 100).toFixed(1)}%p ` +
    `(기준선 25%, ${wins}/${total}승, 전체 예산, seed=${seed})`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.worker) { workerMain(String(args.file)); return; }
  if (args.bench) { bench(); return; }
  if (args.confirm) {
    const workers = Number(args.jobs ?? Math.max(1, Math.min(10, availableParallelism() - 2)));
    await confirmMain(
      String(args.confirm),
      String(args.cand ?? "mean"),
      Number(args.games ?? 240),
      Number(args.seed ?? 77),
      workers,
    );
    return;
  }

  const gens = Number(args.gens ?? 10);
  const pop = Number(args.pop ?? 16);
  const elites = Math.max(2, Math.round(pop / 4));
  const gamesPerCand = Number(args.games ?? 24);
  const validateGames = Number(args.validate ?? 240);
  const seed = Number(args.seed ?? 1);
  const workers = Number(args.jobs ?? Math.max(1, Math.min(10, availableParallelism() - 2)));
  // 적합도 측정용 탐색 예산. 기본 tune(축소·2배 빠름) — full 은 검증과 동일 조건이라
  // 예산 불일치(축소 예산에 과적합)가 없지만 2배 느리다. 장시간 실행 시 권장.
  const fitBudget: "tune" | "full" = args.fitbudget === "full" ? "full" : "tune";

  const rng = new Rng((seed * 2654435761) >>> 0);
  let mean = toVector(WEIGHTS);
  let sigma = mean.map((m) => Math.max(Math.abs(m) * 0.3, 0.05));

  let bestVec = mean.slice();
  let bestFit = -Infinity;
  const history: unknown[] = [];
  console.log(`[tune] gens=${gens} pop=${pop} elites=${elites} games/cand=${gamesPerCand} workers=${workers} (4인, 적합도=순위점수, 기준선 50)`);

  for (let gen = 0; gen < gens; gen++) {
    const t0 = performance.now();
    // 개체군: 현재 평균 + 역대 최고 + 가우시안 샘플
    const vectors: number[][] = [mean.slice()];
    if (bestFit > -Infinity) vectors.push(bestVec.slice());
    while (vectors.length < pop) {
      vectors.push(mean.map((m, i) => Math.max(0, m + gaussian(rng) * sigma[i]!)));
    }

    // 같은 세대의 후보끼리는 같은 보드 시드 공유(짝지은 비교 → 분산 감소)
    const seedBase = (seed + gen * 104729) >>> 0;
    const jobs: Job[] = vectors.map((v) => ({ v, games: gamesPerCand, seedBase, budgetKind: fitBudget }));
    const jobResults = await runJobsParallel(jobs, workers, `gen${gen}`);
    // 적합도 = 평균 순위 점수(기준선 0.5) — 승패(0/1)보다 분산이 작다.
    const scored = vectors.map((v, i) => ({ v, fit: jobResults[i]!.rankScore }));
    scored.sort((a, b) => b.fit - a.fit);

    const elite = scored.slice(0, elites);
    if (elite[0]!.fit > bestFit) { bestFit = elite[0]!.fit; bestVec = elite[0]!.v.slice(); }

    // 평균·표준편차 갱신(+ 수렴 방지 하한)
    mean = KEYS.map((_, i) => elite.reduce((s, e) => s + e.v[i]!, 0) / elite.length);
    sigma = KEYS.map((_, i) => {
      const m = mean[i]!;
      const varc = elite.reduce((s, e) => s + (e.v[i]! - m) ** 2, 0) / elite.length;
      return Math.max(Math.sqrt(varc), Math.abs(m) * 0.03 + 0.01);
    });

    const meanFit = scored.reduce((s, c) => s + c.fit, 0) / scored.length;
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(
      `[gen ${gen + 1}/${gens}] 순위점수 best=${(elite[0]!.fit * 100).toFixed(1)} mean=${(meanFit * 100).toFixed(1)} ` +
      `(역대 best=${(bestFit * 100).toFixed(1)}, 기준선 50) ${secs}s`,
    );
    history.push({ gen: gen + 1, best: elite[0]!.fit, mean: meanFit });
  }

  // 최종 검증: 전체 탐색 예산 + 튜닝과 겹치지 않는 시드. 후보는 역대 best 와 최종 mean 둘 다.
  const finals: { name: string; v: number[] }[] = [
    { name: "best", v: bestVec },
    { name: "mean", v: mean },
  ];
  const perShard = Math.ceil(validateGames / workers / NUM_PLAYERS) * NUM_PLAYERS;
  const validation: Record<string, { winRate: number; ci95: number; wins: number; games: number }> = {};
  for (const f of finals) {
    const jobs: Job[] = Array.from({ length: workers }, (_, s) => ({
      v: f.v,
      games: perShard,
      seedBase: (900_000_001 + seed + s * 15_485_863) >>> 0,
      budgetKind: "full",
    }));
    const rs = await runJobsParallel(jobs, workers, `validate-${f.name}`);
    const wins = rs.reduce((a, r) => a + r.wins, 0);
    const games = rs.reduce((a, r) => a + r.games, 0);
    const rate = wins / games;
    validation[f.name] = { winRate: rate, ci95: ci95(rate, games), wins, games };
    console.log(
      `[validate:${f.name}] 승률 ${(rate * 100).toFixed(1)}% ±${(ci95(rate, games) * 100).toFixed(1)}%p ` +
      `(기준선 25%, ${wins}/${games}승, 전체 예산)`,
    );
  }

  const outDir = resolve(process.cwd(), "tuning-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `tune-seed${seed}.json`);
  writeFileSync(outPath, JSON.stringify({
    config: { gens, pop, elites, gamesPerCand, seed, tuneBudget: TUNE_BUDGET },
    history,
    candidates: { best: toWeights(bestVec), mean: toWeights(mean) },
    validation,
  }, null, 2));
  console.log(`[done] 결과 저장: ${outPath}`);
}

void main();
