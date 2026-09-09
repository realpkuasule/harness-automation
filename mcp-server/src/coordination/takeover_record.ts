import { isAbsolute } from "node:path";
import { z } from "zod";
import { workspaceAssetsSchema } from "../repository/assets.js";
import { coordinationRecordSchema } from "./record.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = coordinationRecordSchema.shape.lastObservedHead;
export const takeoverRiskSchema = z.object({
  schemaVersion: z.literal("takeover-risk/1"),
  target: z.object({ workspace: z.string().refine(isAbsolute), commonDir: z.string().refine(isAbsolute),
    actor: coordinationRecordSchema.shape.owner, hostId: z.string().uuid(), branch: coordinationRecordSchema.shape.branch, head: sha,
    assets: workspaceAssetsSchema, handling: z.literal("retain-all-assets"),
    uniqueCommits: z.number().int().nonnegative(), unpushedCommits: z.number().int().nonnegative(), remoteOnlyCommits: z.number().int().nonnegative(),
  }).strict(),
  remote: z.object({ repositoryId: coordinationRecordSchema.shape.repositoryId, endpointHash: digest,
    ref: z.string().startsWith("refs/heads/"), head: sha,
  }).strict(),
  source: z.object({ kind: z.literal("not-observed"), reason: z.literal("source-machine-not-accessed"), historicalProofHash: digest.optional() }).strict(),
  risks: z.tuple([z.literal("source-assets-unknown"), z.literal("external-writers-not-fenced"), z.literal("old-assets-retained"), z.literal("not-zero-loss-transfer")]),
}).strict();
