import { describe, expect, it } from "vitest";
import { recoveryExecutionAllowed, requireSafeModeCommand } from "./service.js";

describe("recovery safe mode", () => {
  it("rejects mutation and requires semantic human approval for recovery execution", () => {
    expect(() => requireSafeModeCommand("apply")).toThrow("SAFE_MODE_MUTATION_REJECTED");
    expect(() => recoveryExecutionAllowed(undefined, "plan", "packet")).toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  });
});
