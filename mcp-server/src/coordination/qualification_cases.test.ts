import { describe, expect, it } from "vitest";
import { qualificationGroupStatus, recordQualificationSubassertion, requiredQualificationCases } from "./qualification_cases.js";

const evidence = "a".repeat(64);

describe("qualification case inventory", () => {
  it("starts every selected group and assertion as not-run with no evidence", () => {
    const cases = requiredQualificationCases(["dg01-acquire-contention"]);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe("not-run");
    expect(cases[0].subassertions.map((assertion) => assertion.id)).toEqual([
      "dual-contention-single-winner", "stale-tuple-rebind-rejected", "per-transaction-differentiator",
      "bounded-cleanup-authority", "verifier-report-subassertion",
    ]);
    expect(cases[0].subassertions.every((assertion) => assertion.status === "not-run" && assertion.evidenceHash === null)).toBe(true);
  });

  it("records a failure and never lets a later pass overwrite it", () => {
    const cases = requiredQualificationCases(["dg01-acquire-contention"]);
    recordQualificationSubassertion(cases, "dg01-acquire-contention", "bounded-cleanup-authority", "failed", evidence);
    const failed = cases[0].subassertions.find((assertion) => assertion.id === "bounded-cleanup-authority")!;
    expect(failed.status).toBe("failed");
    expect(failed.evidenceHash).toBe(evidence);
    expect(cases[0].status).toBe("failed");

    recordQualificationSubassertion(cases, "dg01-acquire-contention", "bounded-cleanup-authority", "passed", "b".repeat(64));
    expect(failed.status).toBe("failed");
    expect(failed.evidenceHash).toBe(evidence);
    expect(cases[0].status).toBe("failed");
  });

  it("reports a group as incomplete while only part of it ran and as passed once all of it has", () => {
    const cases = requiredQualificationCases(["dg01-acquire-contention"]);
    const group = cases[0];
    recordQualificationSubassertion(cases, group.id, group.subassertions[0].id, "passed", evidence);
    expect(group.status).toBe("incomplete");
    for (const assertion of group.subassertions.slice(1)) {
      recordQualificationSubassertion(cases, group.id, assertion.id, "passed", evidence);
    }
    expect(group.status).toBe("passed");
  });

  it("rejects an unknown group or assertion instead of silently dropping the result", () => {
    const cases = requiredQualificationCases(["dg01-acquire-contention"]);
    expect(() => recordQualificationSubassertion(cases, "dg01-cas", "dual-acquire-single-winner", "passed", evidence))
      .toThrow(/QUALIFICATION_CASE_UNKNOWN/);
    expect(() => recordQualificationSubassertion(cases, "dg01-acquire-contention", "not-an-assertion", "passed", evidence))
      .toThrow(/QUALIFICATION_CASE_UNKNOWN/);
  });

  it("derives the aggregate from the recorded assertions only", () => {
    expect(qualificationGroupStatus([])).toBe("not-run");
    expect(qualificationGroupStatus([{ status: "not-run" }, { status: "not-run" }])).toBe("not-run");
    expect(qualificationGroupStatus([{ status: "passed" }, { status: "not-run" }])).toBe("incomplete");
    expect(qualificationGroupStatus([{ status: "passed" }, { status: "failed" }, { status: "not-run" }])).toBe("failed");
    expect(qualificationGroupStatus([{ status: "passed" }, { status: "passed" }])).toBe("passed");
  });
});
