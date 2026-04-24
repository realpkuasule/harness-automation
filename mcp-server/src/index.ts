#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionEngine } from "./engine.js";
import { StateManager } from "./state.js";
import { generateClaudeMd } from "./generators/claude_md.js";
import { generateEslintConfig } from "./generators/eslint.js";
import { generateSettingsJson } from "./generators/settings_json.js";
import { generateGitignore } from "./generators/gitignore.js";
import { generateHuskyConfig, generateHuskySetupInstructions } from "./generators/husky.js";
import { generateCiWorkflow } from "./generators/ci.js";
import { mergeDependencies } from "./generators/package_json.js";
import { checkDependencies } from "./deps.js";
import { scanAndEvaluate } from "./scanners/integration.js";
import { SetupValidator } from "./validators/setup_validator.js";
import { RuleAnalytics } from "./analytics/rule_analytics.js";
import { RuleAdapter } from "./adapters/rule_adapter.js";
import { RuleIO } from "./io/rule_io.js";
import {
  EvaluateRulesInputSchema,
  GenerateConfigInputSchema,
  ScanCodebaseInputSchema,
  InitHarnessInputSchema,
  RollbackInputSchema,
  ValidateSetupInputSchema,
  RuleStatsInputSchema,
  AnalyzeAdjustmentsInputSchema,
  ExportRulesInputSchema,
  ImportRulesInputSchema,
  ListRulePresetsInputSchema,
  ListRuleExportsInputSchema,
  ConfirmDecisionsInputSchema,
  type Medium,
  type RuleDefinition,
  type RuleDecision,
  type EngineInput,
  type HarnessStatus,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Server Setup
// ============================================================

const server = new Server(
  {
    name: "harness-automation",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ============================================================
// Tool Registration
// ============================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "evaluate_rules",
      description: "评估项目适用的规则，输出推荐介质（CLAUDE.md/settings.json/linter/hook/CI）",
      inputSchema: EvaluateRulesInputSchema,
    },
    {
      name: "generate_config",
      description: "根据规则决策生成配置文件（CLAUDE.md, ESLint, settings.json, .gitignore）",
      inputSchema: GenerateConfigInputSchema,
    },
    {
      name: "query_state",
      description: "查询当前项目的 Harness 状态",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "项目目录绝对路径" },
        },
        required: ["projectDir"],
      },
    },
    {
      name: "reset_state",
      description: "重置 Harness 状态（用于重新开始流程）",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "项目目录绝对路径" },
        },
        required: ["projectDir"],
      },
    },
    {
      name: "scan_codebase",
      description: "扫描代码库，检测违规模式并与现有 CLAUDE.md 规则合并评估",
      inputSchema: ScanCodebaseInputSchema,
    },
    {
      name: "init_harness",
      description: "一键初始化：评估规则 + 生成配置文件（evaluate + generate 快捷方式）",
      inputSchema: InitHarnessInputSchema,
    },
    {
      name: "confirm_decisions",
      description: "确认规则决策，将状态推进到 confirmed。在执行 generate_config 前需要先确认",
      inputSchema: ConfirmDecisionsInputSchema,
    },
    {
      name: "rollback",
      description: "查看备份或回滚到之前的 Harness 配置状态",
      inputSchema: RollbackInputSchema,
    },
    {
      name: "validate_setup",
      description: "验证已生成的 Harness 配置完整性、语法正确性和依赖完整性",
      inputSchema: ValidateSetupInputSchema,
    },
    {
      name: "get_rule_stats",
      description: "收集并返回规则效果统计数据（触发率、修复率、绕过率、按介质分布）",
      inputSchema: RuleStatsInputSchema,
    },
    {
      name: "analyze_rule_adjustments",
      description: "基于使用数据和分析统计推荐规则介质升级/降级调整",
      inputSchema: AnalyzeAdjustmentsInputSchema,
    },
    {
      name: "export_rules",
      description: "导出当前规则配置为可移植 JSON（支持保存到文件或直接返回）",
      inputSchema: ExportRulesInputSchema,
    },
    {
      name: "import_rules",
      description: "从 JSON 导出数据、预设模板或导出文件导入规则配置",
      inputSchema: ImportRulesInputSchema,
    },
    {
      name: "list_rule_presets",
      description: "列出可用规则预设模板（按技术栈过滤）",
      inputSchema: ListRulePresetsInputSchema,
    },
    {
      name: "list_rule_exports",
      description: "列出 .harness/exports/ 中的已保存导出文件",
      inputSchema: ListRuleExportsInputSchema,
    },
  ],
}));

// ============================================================
// Tool Handlers
// ============================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "evaluate_rules": {
      const input = EvaluateRulesInputSchema.parse(args);

      const engine = new DecisionEngine();
      const stateManager = new StateManager(input.projectDir);

      const output = engine.evaluate({
        projectDir: input.projectDir,
        projectPhase: input.projectPhase,
        teamSize: input.teamSize,
        techStack: input.techStack,
        dryRun: input.dryRun,
      });

      // Save to state (unless dry run)
      if (!input.dryRun) {
        stateManager.setEngineInput(input);
        stateManager.setEngineOutput(output);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }

    case "generate_config": {
      const input = GenerateConfigInputSchema.parse(args);

      const stateManager = new StateManager(input.projectDir);
      const state = stateManager.load();

      // Use decisions from input (enriched), or fall back to state
      const decisions: RuleDecision[] = input.decisions.length > 0
        ? enrichPartialDecisions(input.decisions as Array<{ ruleId: string; recommendedMedium: Medium }>)
        : (state.engineOutput?.decisions ?? []);

      if (decisions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "No decisions available. Run evaluate_rules first.",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const files = generateProjectFiles(decisions);

      const summary = {
        total: files.length,
        created: files.filter((f) => f.action === "create").length,
        updated: files.filter((f) => f.action === "update").length,
        skipped: files.filter((f) => f.action === "skip").length,
      };

      const output = { files, summary };

      if (!input.dryRun) {
        stateManager.setConfigOutput(output);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }

    case "query_state": {
      const { projectDir } = args as { projectDir: string };
      const stateManager = new StateManager(projectDir);
      const state = stateManager.load();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    }

    case "reset_state": {
      const { projectDir } = args as { projectDir: string };
      const stateManager = new StateManager(projectDir);
      stateManager.updateStatus(null);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ message: "State reset successfully" }, null, 2),
          },
        ],
      };
    }

    case "scan_codebase": {
      const input = ScanCodebaseInputSchema.parse(args);

      // scanAndEvaluate accepts a full EngineInput; fill optional fields with defaults
      const engineInput: EngineInput = {
        projectDir: input.projectDir,
        projectPhase: input.projectPhase ?? "early",
        teamSize: input.teamSize ?? "small",
        techStack: input.techStack ?? ["generic"],
      };

      const result = await scanAndEvaluate(engineInput, { useCache: input.useCache });

      // Save scan results to state
      const stateManager = new StateManager(input.projectDir);
      stateManager.setEngineInput(engineInput);
      stateManager.setEngineOutput({
        decisions: result.decisions,
        summary: {
          total: result.decisions.length,
          byMedium: result.decisions.reduce(
            (acc, d) => {
              acc[d.recommendedMedium] = (acc[d.recommendedMedium] || 0) + 1;
              return acc;
            },
            {} as Record<Medium, number>,
          ),
          highConfidence: result.decisions.filter((d) => d.confidence >= 0.7).length,
          cognitiveRequired: result.decisions.filter((d) => d.cognitiveLayerRequired).length,
        },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "init_harness": {
      const input = InitHarnessInputSchema.parse(args);

      // Step 1: Evaluate rules
      const engine = new DecisionEngine();
      const evalOutput = engine.evaluate({
        projectDir: input.projectDir,
        projectPhase: input.projectPhase,
        teamSize: input.teamSize,
        techStack: input.techStack,
        dryRun: input.dryRun,
      });

      if (input.dryRun) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                phase: "evaluate",
                decisions: evalOutput.decisions,
                summary: evalOutput.summary,
                message: "Dry run — no config generated. Re-run without --dryRun to generate.",
              }, null, 2),
            },
          ],
        };
      }

      // Step 2: Save state
      const sm = new StateManager(input.projectDir);
      sm.setEngineInput(input);
      sm.setEngineOutput(evalOutput);

      // Step 3: Generate all configs
      const decisions = evalOutput.decisions;

      // Backup existing files before overwriting
      const backupDir = backupGeneratedFiles(input.projectDir);

      const files = generateProjectFiles(decisions);

      // 3e. Husky hooks
      const huskyHooks = generateHuskyConfig({ decisions });
      const hookEntries = Object.entries(huskyHooks);
      for (const [hookName, hookContent] of hookEntries) {
        files.push({
          path: `.husky/${hookName}`,
          content: hookContent,
          action: "create",
        });
      }

      // 3f. CI workflow
      const ciContent = generateCiWorkflow({ decisions, techStack: input.techStack[0] });
      if (ciContent.trim()) {
        files.push({
          path: ".github/workflows/ci.yml",
          content: ciContent,
          action: "create",
        });
      }

      // 3g. Package dependency check
      const depCheck = checkDependencies(input.projectDir);
      const depInfo: Record<string, unknown> | null = depCheck.missing.length > 0 || depCheck.outdated.length > 0
        ? {
            missing: depCheck.missing,
            outdated: depCheck.outdated,
            installCommand: depCheck.installCommand,
          }
        : null;

      if (depInfo) {
        const depMerge = mergeDependencies({ decisions });
        if (depMerge.missing.length > 0) {
          depInfo.suggestedCommands = depMerge.suggestedCommands;
        }
      }

      const summary = {
        files: {
          total: files.length,
          created: files.filter((f) => f.action === "create").length,
          updated: files.filter((f) => f.action === "update").length,
          skipped: files.filter((f) => f.action === "skip").length,
        },
        decisions: evalOutput.summary.total,
        backupDir: backupDir || undefined,
        recommendedActions: depInfo,
        hubSetup: hookEntries.length > 0
          ? generateHuskySetupInstructions()
          : undefined,
      };

      const output = { files, summary };

      sm.setConfigOutput({ files, summary: summary.files });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }

    case "confirm_decisions": {
      const input = ConfirmDecisionsInputSchema.parse(args);
      const stateManager = new StateManager(input.projectDir);
      const state = stateManager.load();

      // Verify status allows confirmation
      const validStatuses: Array<HarnessStatus> = ["evaluated", "confirmed", "generated", "validated"];
      if (!validStatuses.includes(state.status)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Cannot confirm decisions in status '${state.status}'. Run evaluate_rules first.`,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Enrich partial decisions if needed (ruleId + medium only)
      const enriched = input.decisions.length > 0 &&
        typeof input.decisions[0].confidence === "undefined"
        ? enrichPartialDecisions(input.decisions as Array<{ ruleId: string; recommendedMedium: Medium }>)
        : (input.decisions as RuleDecision[]);

      stateManager.setConfirmedDecisions(enriched);

      const byMedium = enriched.reduce(
        (acc, d) => {
          acc[d.recommendedMedium] = (acc[d.recommendedMedium] || 0) + 1;
          return acc;
        },
        {} as Record<Medium, number>,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "confirmed",
              summary: {
                totalRules: enriched.length,
                byMedium,
              },
            }, null, 2),
          },
        ],
      };
    }

    case "rollback": {
      const input = RollbackInputSchema.parse(args);
      const backupRoot = join(input.projectDir, ".harness", "backups");

      if (!existsSync(backupRoot)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "No backups found in .harness/backups/" }, null, 2),
            },
          ],
          isError: true,
        };
      }

      // List backups
      const backups = readdirSync(backupRoot).sort().reverse();

      if (input.list || !input.backupId) {
        const backupList = backups.map((id) => {
          const backupDir = join(backupRoot, id);
          const files = readdirSync(backupDir);
          return { id, files, createdAt: id };
        });

        if (input.list) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ backups: backupList }, null, 2),
              },
            ],
          };
        }

        // No backupId specified and not listing — restore latest
        if (backups.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "No backups available" }, null, 2),
              },
            ],
            isError: true,
          };
        }
      }

      const targetId = input.backupId || backups[0];
      const targetDir = join(backupRoot, targetId);

      if (!existsSync(targetDir)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Backup '${targetId}' not found` }, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Restore: copy files from backup back to projectDir
      const backupFiles = readdirSync(targetDir);
      const restored: string[] = [];

      for (const file of backupFiles) {
        const src = join(targetDir, file);
        const dest = join(input.projectDir, file);
        try {
          // Ensure parent dir exists
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(src, dest, { force: true, recursive: true });
          restored.push(file);
        } catch (e) {
          restored.push(`${file} (failed: ${e})`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: `Restored from backup '${targetId}'`,
              restored,
            }, null, 2),
          },
        ],
      };
    }

    case "validate_setup": {
      const input = ValidateSetupInputSchema.parse(args);
      const validator = new SetupValidator(input);
      const result = validator.validate();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_rule_stats": {
      const input = RuleStatsInputSchema.parse(args);
      const analytics = new RuleAnalytics(input.projectDir);

      let data: import("./analytics/rule_analytics.js").AnalyticsData | null;

      if (input.collect) {
        // Load state and collect fresh analytics
        const stateManager = new StateManager(input.projectDir);
        const state = stateManager.load();

        if (!state.engineOutput) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "No engine output found. Run evaluate_rules or init_harness first.",
                }, null, 2),
              },
            ],
            isError: true,
          };
        }

        data = analytics.collect(state);
      } else {
        data = analytics.getCurrent();
        if (!data) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "No analytics data found. Run with collect=true first.",
                }, null, 2),
              },
            ],
            isError: true,
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }

    case "analyze_rule_adjustments": {
      const input = AnalyzeAdjustmentsInputSchema.parse(args);
      const analytics = new RuleAnalytics(input.projectDir);
      const adapter = new RuleAdapter(input.projectDir);

      const currentData = analytics.getCurrent();
      if (!currentData) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "No analytics data found. Run get_rule_stats first.",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const usageRecords = analytics.getUsageRecords();
      const result = adapter.analyze(currentData, usageRecords);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "export_rules": {
      const input = ExportRulesInputSchema.parse(args);
      const stateManager = new StateManager(input.projectDir);
      const state = stateManager.load();

      if (!state.engineOutput) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "No engine output found. Run evaluate_rules first." }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const io = new RuleIO(input.projectDir);
      const exportData = io.exportRules(state.engineOutput.decisions, {
        projectPhase: state.engineInput?.projectPhase,
        teamSize: state.engineInput?.teamSize,
        techStack: state.engineInput?.techStack,
      });

      let savedPath: string | null = null;
      if (input.saveToFile) {
        savedPath = io.saveExport(exportData, input.filename);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ export: exportData, savedPath }, null, 2),
          },
        ],
      };
    }

    case "import_rules": {
      const input = ImportRulesInputSchema.parse(args);
      const io = new RuleIO(input.projectDir);

      if (input.presetId) {
        const preset = io.getPreset(input.presetId);
        if (!preset) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `Preset '${input.presetId}' not found. Use list_rule_presets to see available presets.` }, null, 2),
              },
            ],
            isError: true,
          };
        }

        const decisions = enrichPartialDecisions(preset.decisions);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                preset: preset.id,
                presetName: preset.name,
                decisions,
                total: decisions.length,
              }, null, 2),
            },
          ],
        };
      }

      if (input.exportJson) {
        const rulesPath = join(__dirname, "rules.json");
        const raw = readFileSync(rulesPath, "utf-8");
        const definitions = JSON.parse(raw) as import("./types.js").RuleDefinition[];

        const exportData = JSON.parse(input.exportJson) as import("./io/rule_io.js").RuleExportData;
        const result = io.importRules(exportData, definitions);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (input.filePath) {
        const exportData = io.loadExport(input.filePath);

        const rulesPath = join(__dirname, "rules.json");
        const raw = readFileSync(rulesPath, "utf-8");
        const definitions = JSON.parse(raw) as import("./types.js").RuleDefinition[];

        const result = io.importRules(exportData, definitions);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Provide one of: presetId, exportJson, or filePath" }, null, 2),
          },
        ],
        isError: true,
      };
    }

    case "list_rule_presets": {
      const input = ListRulePresetsInputSchema.parse(args);
      const io = new RuleIO("");

      let presets = io.listPresets();
      if (input.techStack && input.techStack.length > 0) {
        presets = presets.filter((p) =>
          p.techStack.some((t) => input.techStack!.includes(t)),
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ presets }, null, 2),
          },
        ],
      };
    }

    case "list_rule_exports": {
      const { projectDir } = args as { projectDir: string };
      const io = new RuleIO(projectDir);
      const files = io.listExports();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ exports: files }, null, 2),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ============================================================
// Helpers
// ============================================================

function loadRules(): RuleDefinition[] {
  const rulesPath = join(__dirname, "rules.json");
  const raw = readFileSync(rulesPath, "utf-8");
  return JSON.parse(raw) as RuleDefinition[];
}

/**
 * Enrich partial decisions (ruleId + medium only) into full RuleDecision objects
 * by looking up rule definitions. Used when decisions come from tool input
 * rather than from state (which stores full RuleDecision objects).
 */
function enrichPartialDecisions(
  partials: Array<{ ruleId: string; recommendedMedium: Medium }>,
): RuleDecision[] {
  const rules = loadRules();
  return partials.map((p) => {
    const rule = rules.find((r) => r.id === p.ruleId);
    if (!rule) {
      return {
        ruleId: p.ruleId,
        ruleName: p.ruleId,
        recommendedMedium: p.recommendedMedium,
        alternativeMedia: [],
        confidence: 0.5,
        reasons: ["Rule definition not found"],
        cognitiveLayerRequired: false,
        cognitiveSkillTriggers: [],
      };
    }
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      recommendedMedium: p.recommendedMedium,
      alternativeMedia: rule.alternativeMedium,
      confidence: 0.8,
      reasons: ["User-configured medium assignment"],
      cognitiveLayerRequired: false,
      cognitiveSkillTriggers: [],
    };
  });
}

/**
 * Shared file generation logic used by both generate_config and init_harness.
 * Produces the core config files: CLAUDE.md, ESLint, settings.json, .gitignore.
 */
function generateProjectFiles(
  decisions: RuleDecision[],
): Array<{ path: string; content: string; action: "create" | "update" | "skip" }> {
  const files: Array<{ path: string; content: string; action: "create" | "update" | "skip" }> = [];

  // 1. CLAUDE.md
  files.push({ path: "CLAUDE.md", content: generateClaudeMd({ decisions }), action: "create" });

  // 2. ESLint config (if any linter rules)
  const linterDecisions = decisions.filter((d) => d.recommendedMedium === "linter");
  if (linterDecisions.length > 0) {
    files.push({ path: "eslint.config.json", content: generateEslintConfig({ decisions }), action: "create" });
  }

  // 3. settings.json
  files.push({ path: ".claude/settings.json", content: generateSettingsJson({ decisions }), action: "create" });

  // 4. .gitignore additions
  const gitignoreAdditions = generateGitignore();
  if (gitignoreAdditions.trim()) {
    files.push({ path: ".gitignore", content: gitignoreAdditions, action: "update" });
  }

  return files;
}

/**
 * Backup existing generated files to .harness/backups/<timestamp>/.
 * Returns the backup directory path, or null if no files were backed up.
 */
function backupGeneratedFiles(projectDir: string): string | null {
  const candidates = [
    "CLAUDE.md",
    "eslint.config.json",
    ".claude/settings.json",
    ".husky/pre-commit",
    ".husky/commit-msg",
    ".github/workflows/ci.yml",
  ];

  const toBackup = candidates.filter((f) => existsSync(join(projectDir, f)));
  if (toBackup.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(projectDir, ".harness", "backups", timestamp);
  mkdirSync(backupDir, { recursive: true });

  for (const file of toBackup) {
    const src = join(projectDir, file);
    const dest = join(backupDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { force: true, recursive: true });
  }

  return backupDir;
}

// ============================================================
// Start (stdio transport)
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Harness Automation MCP Server started on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
