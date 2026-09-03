import type { ParsedArguments } from "../cli.js";
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

export function runSessionCommand(root: string, args: ParsedArguments): void {
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
      throw new Error("SESSION_COMMAND_REQUIRED: choose session admit, handoff, status, or seed");
  }
}
