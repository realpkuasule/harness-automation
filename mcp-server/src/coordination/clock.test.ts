import { describe, expect, it } from "vitest";
import { CoordinationClock, DEFAULT_CLOCK_LIMITS, type ClockTick } from "./clock.js";

const date = "Fri, 04 Sep 2026 04:00:00 GMT";
const server = Date.parse(date);
function fixture() {
  let tick: ClockTick = { monotonicMs: 100, wallMs: 500 };
  const clock = new CoordinationClock(() => ({ ...tick }));
  const start = clock.start(); tick = { monotonicMs: 200, wallMs: 600 };
  clock.observe(date, start);
  return { clock, set: (value: ClockTick) => { tick = value; } };
}
describe("conservative authenticated server time", () => {
  it("rejects incomplete or unknown timing policy instead of allowing NaN bounds", () => {
    for (const limits of [{}, { ...DEFAULT_CLOCK_LIMITS, maxSampleAgeMs: undefined }, { ...DEFAULT_CLOCK_LIMITS, surprise: true }, { ...DEFAULT_CLOCK_LIMITS, safetyMarginMs: NaN }]) {
      expect(() => new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 }), limits as never)).toThrow("COORDINATION_CLOCK_LIMITS_INVALID");
    }
  });
  it("includes Date precision, full RTT, elapsed time, margin and drift; never uses local wall time as authority", () => {
    const { clock, set } = fixture();
    expect(clock.bounds().upperMs).toBeGreaterThanOrEqual(server + 2_100);
    set({ monotonicMs: 700, wallMs: 1_100 });
    const upper = clock.bounds().upperMs;
    expect(upper).toBeGreaterThanOrEqual(server + 2_600);
    expect(() => clock.requireBefore(new Date(upper).toISOString())).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    expect(() => clock.requireBefore(new Date(upper + 101).toISOString(), 100)).not.toThrow();
    expect(clock.deadline(60_000)).toBe(new Date(server + 60_499).toISOString());
  });
  it("rejects missing/malformed/replayed dates, long RTT, stale samples and absent process-local evidence", () => {
    const fresh = new CoordinationClock(); expect(() => fresh.bounds()).toThrow("COORDINATION_SERVER_TIME_UNPROVEN");
    for (const header of ["", "2026-09-04", `${date}, ${date}`, "Thu, 04 Sep 2026 04:00:00 GMT"]) {
      const clock = new CoordinationClock();
      expect(() => clock.observe(header, clock.start())).toThrow("COORDINATION_SERVER_TIME_INVALID");
    }
    const { clock, set } = fixture();
    const start = clock.start(); set({ monotonicMs: 7_000, wallMs: 7_400 });
    expect(() => clock.observe(date, start)).toThrow("COORDINATION_SERVER_TIME_UNPROVEN");
    expect(() => clock.bounds()).toThrow("COORDINATION_SERVER_TIME_UNPROVEN");
    const other = fixture(); other.set({ monotonicMs: 11_000, wallMs: 11_400 });
    expect(() => other.clock.bounds()).toThrow("COORDINATION_SERVER_TIME_UNPROVEN");
    const replay = fixture(); replay.set({ monotonicMs: 5_000, wallMs: 5_400 });
    expect(() => replay.clock.observe(date, replay.clock.start())).toThrow("COORDINATION_SERVER_TIME_REGRESSION");
  });
  it("invalidates permanently on wall-clock jump, monotonic rollback, or suspend disagreement", () => {
    for (const tick of [{ monotonicMs: 210, wallMs: -5_000 }, { monotonicMs: 210, wallMs: 50_000 }, { monotonicMs: 90, wallMs: 610 }]) {
      const { clock, set } = fixture(); set(tick);
      expect(() => clock.bounds()).toThrow("COORDINATION_CLOCK_DISCONTINUITY");
      set({ monotonicMs: 200, wallMs: 600 });
      expect(() => clock.bounds()).toThrow("COORDINATION_SERVER_TIME_UNPROVEN");
    }
  });
});
