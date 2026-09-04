export interface ClockTick { monotonicMs: number; wallMs: number; }
export interface ClockLimits {
  maxRoundTripMs: number;
  maxSampleAgeMs: number;
  safetyMarginMs: number;
  maxClockDisagreementMs: number;
  maxRateErrorPpm: number;
}
export const DEFAULT_CLOCK_LIMITS: Readonly<ClockLimits> = Object.freeze({
  maxRoundTripMs: 5_000, maxSampleAgeMs: 10_000, safetyMarginMs: 1_000,
  maxClockDisagreementMs: 1_000, maxRateErrorPpm: 2_000,
});
interface TimeSample { date: string; serverMs: number; start: ClockTick; end: ClockTick; }
const tickNow = (): ClockTick => ({ monotonicMs: Number(process.hrtime.bigint()) / 1e6, wallMs: Date.now() });

/** Process-local evidence only. The fixed authenticated adapter supplies Date; JSON cannot restore a clock. */
export class CoordinationClock {
  private sample?: TimeSample;
  private invalid = false;
  private readonly limits: ClockLimits;
  constructor(private readonly tick = tickNow, limits: ClockLimits = DEFAULT_CLOCK_LIMITS) {
    const keys = Object.keys(DEFAULT_CLOCK_LIMITS) as Array<keyof ClockLimits>;
    if (!limits || Object.keys(limits).length !== keys.length || keys.some((key) => !Number.isFinite(limits[key]) || limits[key] <= 0) || limits.maxRateErrorPpm >= 1_000_000) throw new Error("COORDINATION_CLOCK_LIMITS_INVALID");
    this.limits = { ...limits };
  }
  start(): ClockTick { return this.tick(); }
  private fail(code: string): never { this.invalid = true; this.sample = undefined; throw new Error(code); }
  private elapsed(start: ClockTick, end: ClockTick): number {
    const mono = end.monotonicMs - start.monotonicMs;
    const wall = end.wallMs - start.wallMs;
    // Wall time detects jumps/suspend; it never contributes to lease time or expiry.
    if (![mono, wall].every(Number.isFinite) || mono < 0 || Math.abs(mono - wall) > this.limits.maxClockDisagreementMs) this.fail("COORDINATION_CLOCK_DISCONTINUITY");
    return mono;
  }
  observe(date: string, start: ClockTick): void {
    if (this.invalid) this.fail("COORDINATION_SERVER_TIME_UNPROVEN");
    const serverMs = Date.parse(date);
    if (!Number.isFinite(serverMs) || new Date(serverMs).toUTCString() !== date) this.fail("COORDINATION_SERVER_TIME_INVALID");
    const end = this.tick();
    const rtt = this.elapsed(start, end);
    if (rtt > this.limits.maxRoundTripMs) this.fail("COORDINATION_SERVER_TIME_UNPROVEN");
    if (this.sample) {
      const elapsed = this.elapsed(this.sample.end, end);
      const rate = this.limits.maxRateErrorPpm / 1e6;
      const oldLower = this.sample.serverMs + elapsed * (1 - rate);
      const oldUpper = this.sample.serverMs + 1_000 + this.elapsed(this.sample.start, this.sample.end) + elapsed * (1 + rate) + this.limits.safetyMarginMs;
      const newUpper = serverMs + 1_000 + rtt * (1 + rate) + this.limits.safetyMarginMs;
      if (serverMs < this.sample.serverMs || newUpper < oldLower || serverMs > oldUpper) this.fail("COORDINATION_SERVER_TIME_REGRESSION");
    }
    this.sample = { date, serverMs, start: { ...start }, end };
  }
  bounds(): { lowerMs: number; upperMs: number; date: string; roundTripMs: number; elapsedMs: number } {
    if (this.invalid || !this.sample) this.fail("COORDINATION_SERVER_TIME_UNPROVEN");
    const sample = this.sample;
    const elapsedMs = this.elapsed(sample.end, this.tick());
    if (elapsedMs > this.limits.maxSampleAgeMs) this.fail("COORDINATION_SERVER_TIME_UNPROVEN");
    const roundTripMs = this.elapsed(sample.start, sample.end);
    const rate = this.limits.maxRateErrorPpm / 1e6;
    return {
      lowerMs: sample.serverMs + elapsedMs * (1 - rate),
      upperMs: sample.serverMs + 1_000 + (roundTripMs + elapsedMs) * (1 + rate) + this.limits.safetyMarginMs,
      date: sample.date, roundTripMs, elapsedMs,
    };
  }
  requireBefore(expiresAt: string, operationBudgetMs = 0): ReturnType<CoordinationClock["bounds"]> {
    const bounds = this.bounds();
    if (!Number.isFinite(operationBudgetMs) || operationBudgetMs < 0 || !Number.isFinite(Date.parse(expiresAt)) || bounds.upperMs + operationBudgetMs >= Date.parse(expiresAt)) throw new Error("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    return bounds;
  }
  deadline(ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("COORDINATION_TTL_INVALID");
    // Conservative lower bound avoids silently granting RTT/margin as extra TTL.
    return new Date(Math.floor(this.bounds().lowerMs + ttlMs)).toISOString();
  }
}
