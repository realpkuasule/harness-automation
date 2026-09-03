import type { ParsedArguments } from "../cli.js";
import { prepareDelivery } from "../delivery/prepare.js";
import { admitSession } from "./admission.js";
import { sessionHandoff, sessionSeed, sessionStatus } from "./service.js";

function value(args: ParsedArguments, name: string): string | undefined {
  return args.values.get(name)?.at(-1);
}

function required(args: ParsedArguments, name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`ARGUMENT_REQUIRED: --${name}`);
  return result;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function localPhase(args: ParsedArguments): number | undefined {
  const selected = value(args, "phase");
  if (selected === undefined) return undefined;
  const result = Number(selected);
  if (!Number.isInteger(result) || result < 0 || result > 999) throw new Error("DELIVERY_PREPARE_PHASE_INVALID");
  return result;
}

export async function runSessionCommand(root: string, args: ParsedArguments): Promise<void> {
  const action = args.positionals[0];
  switch (action) {
    case "admit":
      printJson(admitSession({
        projectRoot: root,
        session: required(args, "session"),
        intent: value(args, "intent"),
        contextReceipt: value(args, "context-receipt"),
        workItem: value(args, "work-item"),
        reclassify: args.flags.has("reclassify"),
        managedWrite: args.flags.has("managed-write"),
      }));
      return;
    case "prepare":
      printJson(await prepareDelivery({
        projectRoot: root,
        session: required(args, "session"),
        confirmation: required(args, "confirm"),
        baseRef: required(args, "base"),
        baseSha: required(args, "base-sha"),
        localOnly: args.flags.has("local-only"),
        workItem: value(args, "work-item"),
        title: value(args, "title"),
        description: value(args, "description"),
        priority: value(args, "priority") as "critical" | "high" | "medium" | "low" | undefined,
        phase: localPhase(args),
        owner: required(args, "owner"),
        branch: value(args, "branch"),
        path: value(args, "path"),
      }));
      return;
    case "status":
      printJson(sessionStatus({ projectRoot: root, workItem: value(args, "work-item") }));
      return;
    case "seed":
      printJson(sessionSeed({ projectRoot: root, workItem: required(args, "work-item") }));
      return;
    case "handoff":
      printJson(sessionHandoff({
        projectRoot: root,
        workItem: required(args, "work-item"),
        session: required(args, "session"),
        toStatus: value(args, "to-status"),
        dryRun: args.flags.has("dry-run"),
      }));
      return;
    default:
      throw new Error("SESSION_COMMAND_REQUIRED: choose session admit, prepare, handoff, status, or seed");
  }
}
