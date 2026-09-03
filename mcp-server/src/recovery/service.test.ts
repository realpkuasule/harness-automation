import { describe, expect, it } from "vitest";
import { recoveryExecutionAllowed, requireSafeModeCommand } from "./service.js";

describe("recovery safe mode", () => {
  it("rejects mutation and requires semantic human approval for recovery execution", () => {
    expect(() => requireSafeModeCommand("apply")).toThrow("SAFE_MODE_MUTATION_REJECTED");
    expect(() => recoveryExecutionAllowed(undefined, "plan", "packet")).toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
    expect(() => recoveryExecutionAllowed({ kind: "semantic-human-approval/3.0", planHash: "plan", packetHash: "packet", approvedBy: "owner", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z" }, "plan", "packet")).toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  });
});
