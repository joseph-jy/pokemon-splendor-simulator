import { describe, it, expect } from "vitest";
import { WEIGHTS } from "@/strategy/weights";
import { playMatch, playSeries, ci95 } from "./arena";

// 테스트 속도용 초소형 탐색 예산.
const TINY = { candidates: 4, rolloutTurns: 4 };

describe("tuning arena", () => {
  it("playMatch: 동일 좌석·시드 → 동일 결과(재현성)", () => {
    const seats = [WEIGHTS, WEIGHTS];
    const a = playMatch(seats, 42, TINY);
    const b = playMatch(seats, 42, TINY);
    expect(a).toEqual(b);
    expect(a.winner).toBeGreaterThanOrEqual(0);
    expect(a.winner).toBeLessThan(2);
  });

  it("playSeries: 좌석 로테이션 + 승률 범위", () => {
    const r = playSeries(WEIGHTS, WEIGHTS, 4, 2, 7, TINY);
    expect(r.games).toBe(4);
    expect(r.wins).toBeGreaterThanOrEqual(0);
    expect(r.wins).toBeLessThanOrEqual(4);
    expect(r.baselineRate).toBe(0.5);
  });

  it("ci95: 표본 증가 시 구간 축소", () => {
    expect(ci95(0.3, 400)).toBeLessThan(ci95(0.3, 100));
  });
});
