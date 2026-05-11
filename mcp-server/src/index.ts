#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, mkdirSync, readdirSync, cpSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { DecisionEngine } from "./engine.js";
import { StateManager } from "./state.js";
import { generateClaudeMd } from "./generators/claude_md.js";
import { generateEslintConfig } from "./generators/eslint.js";
import { generateSettingsJson } from "./generators/settings_json.js";
import { generateGitignore } from "./generators/gitignore.js";
import { generateHuskyConfig, generateHuskySetupInstructions, generateCommitlintConfig } from "./generators/husky.js";
import { generateCiWorkflow } from "./generators/ci.js";
import { mergeDependencies } from "./generators/package_json.js";
import { checkDependencies } from "./deps.js";
import { scanAndEvaluate } from "./scanners/integration.js";
import { assessSuitability } from "./suitability/assessor.js";
import { startABTest, collectDataPoint } from "./ab_test/manager.js";
import { analyzeABResults } from "./ab_test/analyzer.js";
import { processCognitiveRequest, shouldAutoTrigger } from "./cognitive_layer/orchestrator.js";
import type { CognitiveResponse, TriggerEntry } from "./cognitive_layer/orchestrator.js";
import type { CognitiveAutoTrigger } from "./types.js";
import { generateErrorSuggestion } from "./error_optimization/generator.js";
import { ErrorMessageEvaluator } from "./error_optimization/evaluator.js";
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
  AnalyzeABResultsInputSchema,
  AssessSuitabilityInputSchema,
  CognitiveSkillInputSchema,
  CollectABMetricsInputSchema,
  OptimizeErrorMessageInputSchema,
  QueryStateInputSchema,
  ResetStateInputSchema,
  StartABTestInputSchema,
  SuggestErrorImprovementInputSchema,
  type RuleMedium,
  type RuleDefinition,
  type RuleDecision,
  type EngineInput,
  type HarnessStatus,
  type HarnessError,
  type GenerateConfigOutput,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Server Factory
// ============================================================

export async function createServer(): Promise<Server> {
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
// Zod → JSON Schema helper
// ============================================================

function z(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema) as Record<string, unknown>;
}

// ============================================================
// Tool Registration
// ============================================================

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "evaluate_rules",
        description: "评估项目适用的规则，输出推荐介质（linter_error/linter_warn/linter+hook/claude_md/ci/hook/settings/none）",
        inputSchema: z(EvaluateRulesInputSchema),
      },
      {
        name: "generate_config",
        description: "根据规则决策生成配置文件（CLAUDE.md, ESLint, settings.json, .gitignore）",
        inputSchema: z(GenerateConfigInputSchema),
      },
      {
        name: "query_state",
        description: "查询当前项目的 Harness 状态",
        inputSchema: z(QueryStateInputSchema),
      },
      {
        name: "reset_state",
        description: "将状态机的 phase 重置为 null，用于重新开始流程",
        inputSchema: z(ResetStateInputSchema),
      },
      {
        name: "scan_codebase",
        description: "扫描代码库，检测违规模式并与现有 CLAUDE.md 规则合并评估",
        inputSchema: z(ScanCodebaseInputSchema),
      },
      {
        name: "init_harness",
        description: "快捷入口：跳过交互，内部依次调用 evaluate_rules → 自动确认决策 → generate_config → validate_setup。额外生成：.husky/ Git hooks、.github/workflows/ci.yml CI 流水线、package.json 依赖检查与合并。适用于二次运行、CI 环境、有经验的用户。",
        inputSchema: z(InitHarnessInputSchema),
      },
      {
        name: "confirm_decisions",
        description: "确认规则决策，将状态推进到 confirmed。在执行 generate_config 前需要先确认",
        inputSchema: z(ConfirmDecisionsInputSchema),
      },
      {
        name: "rollback",
        description: "查看备份或回滚到之前的 Harness 配置状态",
        inputSchema: z(RollbackInputSchema),
      },
      {
        name: "validate_setup",
        description: "验证已生成的 Harness 配置完整性、语法正确性和依赖完整性",
        inputSchema: z(ValidateSetupInputSchema),
      },
      {
        name: "get_rule_stats",
        description: "收集并返回规则效果统计数据（触发率、修复率、绕过率、按介质分布）",
        inputSchema: z(RuleStatsInputSchema),
      },
      {
        name: "analyze_rule_adjustments",
        description: "基于使用数据和分析统计推荐规则介质升级/降级调整",
        inputSchema: z(AnalyzeAdjustmentsInputSchema),
      },
      {
        name: "export_rules",
        description: "导出当前规则配置为可移植 JSON（支持保存到文件或直接返回）",
        inputSchema: z(ExportRulesInputSchema),
      },
      {
        name: "import_rules",
        description: "从 JSON 导出数据、预设模板或导出文件导入规则配置",
        inputSchema: z(ImportRulesInputSchema),
      },
      {
        name: "list_rule_presets",
        description: "列出可用规则预设模板（按技术栈过滤）",
        inputSchema: z(ListRulePresetsInputSchema),
      },
      {
        name: "list_rule_exports",
        description: "列出 .harness/exports/ 中的已保存导出文件",
        inputSchema: z(ListRuleExportsInputSchema),
      },
      {
        name: "assess_suitability",
        description: "评估项目是否适合应用 Harness 约束体系。检查 Git 历史、文件结构、依赖管理和测试覆盖",
        inputSchema: z(AssessSuitabilityInputSchema),
      },
      {
        name: "start_ab_test",
        description: "启动一个新的 A/B 测试，对比两种介质配置的效果",
        inputSchema: z(StartABTestInputSchema),
      },
      {
        name: "collect_ab_metrics",
        description: "为一个活跃的 A/B 测试收集一条数据点",
        inputSchema: z(CollectABMetricsInputSchema),
      },
      {
        name: "analyze_ab_results",
        description: "分析 A/B 测试结果，返回统计显著性和推荐操作",
        inputSchema: z(AnalyzeABResultsInputSchema),
      },
      {
        name: "cognitive_skill",
        description: "认知层技能调用：诊断（diagnostic）、教育（educational）、决策支持（decision-support）。需指定 ruleId 和 skillType",
        inputSchema: z(CognitiveSkillInputSchema),
      },
      {
        name: "suggest_error_improvement",
        description: "分析错误信息模板使用效果，返回统计数据并建议优化方向。基于模板使用频率、用户评分和修复率生成改进建议",
        inputSchema: z(SuggestErrorImprovementInputSchema),
      },
      {
        name: "optimize_error_message",
        description: "生成优化后的错误信息。根据规则 ID、场景或代码上下文返回包含 why/whatInstead/reference 三要素的结构化错误信息",
        inputSchema: z(OptimizeErrorMessageInputSchema),
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
        stateManager.setProjectInfo(input.techStack, input.projectPhase, input.teamSize);
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
        ? enrichPartialDecisions(input.decisions as Array<{ ruleId: string; recommendedMedium: RuleMedium }>)
        : (state.engineOutput?.decisions ?? []);

      if (decisions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "NO_DECISIONS", message: "No decisions available. Run evaluate_rules first.", recoverable: true,
              } satisfies HarnessError, null, 2),
            },
          ],
          isError: true,
        };
      }

      const files = generateProjectFiles(decisions, input.projectDir);

      const errors: Array<{ file: string; message: string; code: string }> = [];
      const warnings: string[] = [];

      // Write files to disk (unless dry run)
      let backupDir: string | null = null;
      const writtenFiles = new Set<string>();
      if (!input.dryRun) {
        backupDir = backupGeneratedFiles(input.projectDir);
        for (const f of files) {
          const filePath = join(input.projectDir, f.path);
          try {
            const exists = existsSync(filePath);
            // Adjust action based on actual disk state
            if (exists && f.action === "created") {
              (f as any).action = "overwritten";
            }
            if (f.action !== "skipped") {
              mkdirSync(dirname(filePath), { recursive: true });
              writeFileSync(filePath, f.content, "utf-8");
              if (f.path.startsWith(".husky/")) {
                chmodSync(filePath, 0o755);
              }
              writtenFiles.add(f.path);
              // Set backupPath for overwritten files
              if (exists && backupDir) {
                (f as any).backupPath = join(backupDir, f.path);
              }
            }
          } catch (e) {
            errors.push({ file: f.path, message: String(e), code: "FILE_WRITE_ERROR" });
          }
        }
      }

      const output: GenerateConfigOutput = {
        files: input.dryRun ? files.map((f) => ({ ...f, action: "dry_run" as const })) : files,
        summary: {
          total: files.length,
          created: files.filter((f) => f.action === "created" || f.action === "merged").length,
          updated: files.filter((f) => f.action === "overwritten").length,
          skipped: files.filter((f) => f.action === "skipped").length,
        },
        errors,
        warnings,
      };

      if (!input.dryRun) {
        stateManager.setConfigOutput(output);
        stateManager.logGeneration({
          phase: "generated",
          timestamp: new Date().toISOString(),
          action: input.dryRun ? "dry_run" : "generate",
          detail: `Generated ${files.length} files (${output.summary.created} created, ${output.summary.updated} updated, ${output.summary.skipped} skipped)`,
        });
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
      const { projectDir } = QueryStateInputSchema.parse(args);
      const stateManager = new StateManager(projectDir);
      const state = stateManager.load();

      const stateExists = state.phase !== null;
      const summary: Record<string, unknown> = {};

      if (state.engineOutput) {
        summary.totalDecisions = state.engineOutput.decisions.length;
        summary.byMedium = state.engineOutput.summary.byMedium;
        summary.highConfidence = state.engineOutput.summary.highConfidence;
        summary.cognitiveRequired = state.engineOutput.summary.cognitiveRequired;
        summary.conflicts = state.engineOutput.conflicts.length;
      }

      if (state.configOutput) {
        summary.generatedFiles = state.configOutput.summary.total;
      }

      const result: Record<string, unknown> = {
        stateExists,
        phase: state.phase,
      };

      if (state.project) {
        result.project = state.project;
      }

      if (state.engineInput) {
        result.lastEvalAt = state.evaluatedAt ?? state.updatedAt;
      }

      if (state.confirmedAt) {
        result.confirmedAt = state.confirmedAt;
      }

      if (state.validatedAt) {
        result.validatedAt = state.validatedAt;
      }

      if (state.validation) {
        result.validation = state.validation;
      }

      if (state.sessionId) {
        result.sessionId = state.sessionId;
      }

      if (state.generationLog && state.generationLog.length > 0) {
        result.generationLog = state.generationLog;
      }

      result.summary = summary;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "reset_state": {
      const { projectDir } = ResetStateInputSchema.parse(args);
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

      const result = await scanAndEvaluate(engineInput, { useCache: input.useCache, scanDepth: input.scanDepth });

      // Save scan results to state
      const stateManager = new StateManager(input.projectDir);
      const engine = new DecisionEngine();
      const detectedConflicts = engine.detectConflicts(result.decisions);
      stateManager.setEngineInput(engineInput);
      stateManager.setEngineOutput({
        decisions: result.decisions,
        conflicts: detectedConflicts,
        summary: {
          total: result.decisions.length,
          byMedium: result.decisions.reduce(
            (acc, d) => {
              acc[d.recommendedMedium] = (acc[d.recommendedMedium] || 0) + 1;
              return acc;
            },
            {} as Record<RuleMedium, number>,
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

      // Merge preset with flat params (flat params take precedence)
      if (input.preset) {
        input.projectPhase = input.projectPhase ?? input.preset.projectPhase ?? "early";
        input.teamSize = input.teamSize ?? input.preset.teamSize ?? "small";
        input.techStack = input.techStack ?? input.preset.techStack ?? ["generic"];
      }

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
                files: [],
                summary: {
                  files: { total: 0, created: 0, updated: 0, skipped: 0 },
                  decisions: evalOutput.summary.total,
                },
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

      const files = generateProjectFiles(decisions, input.projectDir);

      // 3e. Husky hooks
      const huskyHooks = generateHuskyConfig({ decisions });
      const hookEntries = Object.entries(huskyHooks);
      for (const [hookName, hookContent] of hookEntries) {
        files.push({
          path: `.husky/${hookName}`,
          content: hookContent,
          action: "created",
        });
      }

      // 3f. CI workflow — skip if already exists (don't overwrite existing CI)
      const ciFilePath = join(input.projectDir, ".github/workflows/ci.yml");
      if (existsSync(ciFilePath)) {
        console.error(`CI workflow already exists at .github/workflows/ci.yml — skipping to avoid overwriting`);
        files.push({ path: ".github/workflows/ci.yml", content: "", action: "skipped" });
      } else {
        const ciContent = generateCiWorkflow({ decisions, techStack: input.techStack[0], projectPhase: input.projectPhase });
        if (ciContent.trim()) {
          files.push({
            path: ".github/workflows/ci.yml",
            content: ciContent,
            action: "created",
          });
        }
      }

      // Check if commitlint config should be generated (when commit-msg hook exists)
      const hasCommitMsgHook = hookEntries.some(([name]) => name === "commit-msg");
      if (hasCommitMsgHook) {
        const commitlintPath = join(input.projectDir, "commitlint.config.js");
        if (!existsSync(commitlintPath)) {
          files.push({
            path: "commitlint.config.js",
            content: generateCommitlintConfig(),
            action: "created",
          });
        }
      }

      // 3g. Package dependency check + package.json merge
      const depCheck = checkDependencies(input.projectDir);
      const depInfo: Record<string, unknown> | null = depCheck.missing.length > 0 || depCheck.outdated.length > 0
        ? {
            missing: depCheck.missing,
            outdated: depCheck.outdated,
            installCommand: depCheck.installCommand,
          }
        : null;

      // 3h. Package.json smart merge
      const packageJsonPath = join(input.projectDir, "package.json");
      const hasLintStageRelevant = decisions.some(
        (d) =>
          d.recommendedMedium === "linter_error" ||
          d.recommendedMedium === "linter_warn" ||
          d.recommendedMedium === "linter" ||
          d.recommendedMedium === "hook",
      );
      const lintStagedConfig = hasLintStageRelevant
        ? {
            "*.{js,jsx,ts,tsx}": ["eslint --fix --max-warnings=0"],
            "*.{json,md,yaml,yml}": ["prettier --write"],
          }
        : null;

      if (existsSync(packageJsonPath)) {
        // Read existing package.json, merge devDependencies and lint-staged
        try {
          const existingRaw = readFileSync(packageJsonPath, "utf-8");
          const existingPkg = JSON.parse(existingRaw);
          const depMerge = mergeDependencies({ decisions, existingPackageJson: existingPkg });
          if (depInfo) {
            if (depMerge.missing.length > 0) {
              depInfo.suggestedCommands = depMerge.suggestedCommands;
            }
          }
          // If any packages are actually needed, merge them in
          const mergedDevDeps: Record<string, string> = {
            ...(existingPkg.devDependencies || {}),
          };
          let hasChanges = false;
          for (const dep of depMerge.missing) {
            mergedDevDeps[dep] = "*";
            hasChanges = true;
          }
          if (hasChanges || lintStagedConfig) {
            if (hasChanges) {
              existingPkg.devDependencies = mergedDevDeps;
            }
            if (lintStagedConfig) {
              existingPkg["lint-staged"] = lintStagedConfig;
            }
            files.push({
              path: "package.json",
              content: JSON.stringify(existingPkg, null, 2) + "\n",
              action: "merged",
            });
          }
        } catch {
          // If reading/parsing fails, log and skip
          console.error("Failed to read or parse existing package.json — skipping merge");
        }
      } else {
        // Create minimal package.json
        const depMerge = mergeDependencies({ decisions });
        if (depInfo) {
          if (depMerge.missing.length > 0) {
            depInfo.suggestedCommands = depMerge.suggestedCommands;
          }
        }
        const dirName = input.projectDir.split("/").filter(Boolean).pop() || "project";
        const newPkg: Record<string, unknown> = {
          name: dirName,
          private: true,
          type: "module",
          scripts: {},
        };
        if (depMerge.missing.length > 0) {
          const devDeps: Record<string, string> = {};
          for (const dep of depMerge.missing) {
            devDeps[dep] = "*";
          }
          newPkg.devDependencies = devDeps;
        }
        if (lintStagedConfig) {
          newPkg["lint-staged"] = lintStagedConfig;
        }
        files.push({
          path: "package.json",
          content: JSON.stringify(newPkg, null, 2) + "\n",
          action: "created",
        });
      }

      // Log a note if .lintstagedrc.json already exists (can be removed in favor of package.json)
      const lintstagedrcPath = join(input.projectDir, ".lintstagedrc.json");
      if (existsSync(lintstagedrcPath)) {
        console.error(".lintstagedrc.json exists — lint-staged config is now in package.json; .lintstagedrc.json can be removed");
      }

      const fileSummary = {
        total: files.length,
        created: files.filter((f) => f.action === "created" || f.action === "merged").length,
        updated: files.filter((f) => f.action === "overwritten").length,
        skipped: files.filter((f) => f.action === "skipped").length,
      };

      // Write files to disk
      const errors: Array<{ file: string; message: string; code: string }> = [];
      for (const f of files) {
        const filePath = join(input.projectDir, f.path);
        try {
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, f.content, "utf-8");
          if (f.path.startsWith(".husky/")) {
            chmodSync(filePath, 0o755);
          }
        } catch (e) {
          errors.push({ file: f.path, message: String(e), code: "FILE_WRITE_ERROR" });
        }
      }

      const permissionHint = {
        note: "为提高效率，建议将常用 MCP 工具加入 permissions allowlist",
        command: "运行 /fewer-permission-prompts 或在 .claude/settings.local.json 中配置",
        suggestedTools: [
          "mcp__harness-automation__evaluate_rules",
          "mcp__harness-automation__generate_config",
          "mcp__harness-automation__query_state",
          "mcp__harness-automation__init_harness",
          "mcp__harness-automation__validate_setup",
        ],
      };

      const summary = {
        files: fileSummary,
        decisions: evalOutput.summary.total,
        backupDir: backupDir || null,
        recommendedActions: depInfo,
        huskySetup: hookEntries.length > 0
          ? generateHuskySetupInstructions()
          : null,
        permissions: permissionHint,
        installNote: "Installing dependencies may take 2-5 minutes depending on network speed and package count",
      };

      const output = { files, summary, errors };

      sm.setConfigOutput({ files, summary: fileSummary, errors, warnings: [] });
      sm.setProjectInfo(input.techStack, input.projectPhase, input.teamSize);
      sm.logGeneration({
        phase: "generated",
        timestamp: new Date().toISOString(),
        action: "init",
        detail: `init_harness generated ${files.length} files`,
      });

      // Step 4: Validate setup (design §3.1.7)
      const validator = new SetupValidator({ projectDir: input.projectDir });
      const validationResult = validator.validate();
      sm.setValidation(validationResult);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...output, validation: validationResult }, null, 2),
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
      if (!validStatuses.includes(state.phase)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "STATE_PHASE_MISMATCH", message: `Cannot confirm decisions in phase '${state.phase}'. Run evaluate_rules first.`, detail: "confirm_decisions requires phase to be evaluated/confirmed/generated/validated", recoverable: true,
              } satisfies HarnessError, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Enrich partial decisions if needed (ruleId + medium only)
      const enriched: RuleDecision[] = input.decisions.length > 0 &&
        typeof input.decisions[0].confidence === "undefined"
        ? enrichPartialDecisions(input.decisions as Array<{ ruleId: string; recommendedMedium: RuleMedium }>)
        : (input.decisions as RuleDecision[]);

      stateManager.setConfirmedDecisions(enriched);

      const byMedium = enriched.reduce(
        (acc, d) => {
          acc[d.recommendedMedium] = (acc[d.recommendedMedium] || 0) + 1;
          return acc;
        },
        {} as Record<RuleMedium, number>,
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
              text: JSON.stringify({
                code: "ROLLBACK_FAILED", message: "No backups found in .harness/backups/", recoverable: true,
              } satisfies HarnessError, null, 2),
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
                text: JSON.stringify({
                  code: "ROLLBACK_FAILED", message: "No backups available", recoverable: true,
                } satisfies HarnessError, null, 2),
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
              text: JSON.stringify({
                code: "ROLLBACK_FAILED", message: `Backup '${targetId}' not found`, recoverable: true,
              } satisfies HarnessError, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Restore: copy files from backup back to projectDir
      const backupFiles = readdirSync(targetDir);
      const restored: string[] = [];
      const failed: string[] = [];
      const errors: string[] = [];

      for (const file of backupFiles) {
        const src = join(targetDir, file);
        const dest = join(input.projectDir, file);
        try {
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(src, dest, { force: true, recursive: true });
          restored.push(file);
        } catch (e) {
          failed.push(file);
          errors.push(`Failed to restore ${file}: ${e}`);
        }
      }

      // Clean up generated files that exist in project but not in backup
      const managedFiles = [
        "CLAUDE.md", "eslint.config.js", ".claude/settings.json",
        ".husky/pre-commit", ".husky/commit-msg", ".github/workflows/ci.yml",
      ];
      const cleaned: string[] = [];
      for (const file of managedFiles) {
        if (!backupFiles.includes(file)) {
          const fp = join(input.projectDir, file);
          try {
            if (existsSync(fp)) {
              rmSync(fp, { force: true });
              cleaned.push(file);
            }
          } catch {
            // best effort cleanup
          }
        }
      }

      const status: "success" | "partial" | "failed" =
        failed.length === 0 && restored.length > 0 ? "success"
        : restored.length > 0 ? "partial"
        : "failed";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status,
              restored,
              failed: failed.length > 0 ? failed : null,
              backupId: targetId,
              errors: errors.length > 0 ? errors : null,
              cleaned: cleaned.length > 0 ? cleaned : null,
            }, null, 2),
          },
        ],
      };
    }

    case "validate_setup": {
      const input = ValidateSetupInputSchema.parse(args);
      const validator = new SetupValidator(input);
      const result = validator.validate();
      // Store validation result in state
      const stateManager = new StateManager(input.projectDir);
      stateManager.setValidation(result);
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
                  code: "STATE_NOT_FOUND", message: "No engine output found. Run evaluate_rules or init_harness first.", recoverable: true,
                } satisfies HarnessError, null, 2),
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
                  code: "STATE_NOT_FOUND", message: "No analytics data found. Run with collect=true first.", recoverable: true,
                } satisfies HarnessError, null, 2),
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
                code: "DEPENDENCY_MISSING", message: "No analytics data found. Run get_rule_stats first.", recoverable: true,
              } satisfies HarnessError, null, 2),
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
              text: JSON.stringify({
                code: "STATE_NOT_FOUND", message: "No engine output found. Run evaluate_rules first.", recoverable: true,
              } satisfies HarnessError, null, 2),
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
                text: JSON.stringify({
                  code: "INVALID_CONFIG", message: `Preset '${input.presetId}' not found. Use list_rule_presets to see available presets.`, recoverable: true,
                } satisfies HarnessError, null, 2),
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
            text: JSON.stringify({
              code: "INVALID_CONFIG", message: "Provide one of: presetId, exportJson, or filePath", recoverable: true,
            } satisfies HarnessError, null, 2),
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
      const { projectDir } = ListRuleExportsInputSchema.parse(args);
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

    case "start_ab_test": {
      const abInput = StartABTestInputSchema.parse(args);
      const rawMetrics = abInput.metrics ?? ["triggerCount", "fixRate", "bypassCount"];
      const normalizedMetrics = rawMetrics.map((m) =>
        typeof m === "string" ? { name: m, weight: 1 } : m,
      );
      const config = {
        ruleId: abInput.ruleId,
        baselineMedium: normalizeMediumInput(abInput.baselineMedium),
        testMedium: normalizeMediumInput(abInput.testMedium),
        durationDays: abInput.durationDays ?? 14,
        metrics: normalizedMetrics,
      };
      const result = startABTest(abInput.projectDir, config);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "collect_ab_metrics": {
      const cmInput = CollectABMetricsInputSchema.parse(args);
      const dataPoint = {
        timestamp: new Date().toISOString(),
        triggerCount: cmInput.triggerCount,
        fixRate: cmInput.fixRate,
        bypassCount: cmInput.bypassCount,
        userFeedback: cmInput.userFeedback,
      };
      const result = collectDataPoint(cmInput.projectDir, cmInput.testId, dataPoint);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "analyze_ab_results": {
      const aaInput = AnalyzeABResultsInputSchema.parse(args);
      const result = analyzeABResults(aaInput);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "assess_suitability": {
      const input = AssessSuitabilityInputSchema.parse(args);
      const assessment = assessSuitability(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(assessment, null, 2),
          },
        ],
      };
    }

    case "cognitive_skill": {
      const cogInput = CognitiveSkillInputSchema.parse(args);
      let result: CognitiveResponse;
      try {
        result = processCognitiveRequest(cogInput);
      } catch (e) {
        const msg = String(e);
        const isRuleNotFound = msg.includes("not found");
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: isRuleNotFound ? "INVALID_CONFIG" : "UNKNOWN_ERROR",
            message: msg,
            recoverable: true,
          } satisfies HarnessError, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "suggest_error_improvement": {
      const seInput = SuggestErrorImprovementInputSchema.parse(args);
      const evaluator = new ErrorMessageEvaluator(seInput.projectDir);
      const stats = evaluator.getStats();

      const suggestions: string[] = [];
      for (const [templateId, tStat] of Object.entries(stats.templateStats)) {
        if (tStat.uses > 0 && tStat.averageRating < 3) {
          suggestions.push(`模板 ${templateId} 使用 ${tStat.uses} 次，平均评分 ${tStat.averageRating.toFixed(1)}，建议优化内容以提高清晰度`);
        } else if (tStat.uses === 0) {
          suggestions.push(`模板 ${templateId} 尚未使用，考虑在相关场景中推广`);
        } else {
          suggestions.push(`模板 ${templateId} 使用 ${tStat.uses} 次，平均评分 ${tStat.averageRating.toFixed(1)}，效果良好`);
        }
      }

      if (stats.totalRecords === 0) {
        suggestions.push("暂无错误信息模板使用记录。建议先调用 optimize_error_message 生成错误信息以积累数据");
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ stats, suggestions }, null, 2) }],
      };
    }

    case "optimize_error_message": {
      const optInput = OptimizeErrorMessageInputSchema.parse(args);
      const suggestions = generateErrorSuggestion({
        ruleId: optInput.ruleId,
        ruleName: optInput.ruleName,
        scenario: optInput.scenario,
        actualCode: optInput.actualCode,
        fileName: optInput.fileName,
        lineNumber: optInput.lineNumber,
      });

      // Record to evaluator if projectDir is provided
      let stats: import("./error_optimization/evaluator.js").EvaluationStats | undefined;
      if (optInput.projectDir && optInput.rateAfter !== false) {
        const evaluator = new ErrorMessageEvaluator(optInput.projectDir);
        for (const s of suggestions) {
          evaluator.recordSuggestion(s, optInput.scenario ?? optInput.ruleId ?? "unknown");
        }
        stats = evaluator.getStats();
      }

      // Record trigger history for repeated pattern detection
      let repeatedPattern: CognitiveAutoTrigger | null = null;
      if (optInput.projectDir && optInput.ruleId) {
        const historyPath = join(optInput.projectDir, ".harness", "trigger_history.json");
        let history: TriggerEntry[] = [];
        try {
          if (existsSync(historyPath)) {
            history = JSON.parse(readFileSync(historyPath, "utf-8")) as TriggerEntry[];
          }
        } catch { /* ignore corrupt history */ }
        history.push({ ruleId: optInput.ruleId, timestamp: new Date().toISOString() });
        try {
          mkdirSync(join(optInput.projectDir, ".harness"), { recursive: true });
          writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
        } catch { /* best-effort write */ }
        repeatedPattern = shouldAutoTrigger(history);
      }

      const result: Record<string, unknown> = { suggestions, stats };
      if (repeatedPattern) {
        result.repeatedPattern = repeatedPattern;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "UNKNOWN_TOOL",
              message: `Unknown tool: ${name}`,
              detail: `The tool "${name}" is not registered. Available tools are listed in the server capabilities.`,
              recoverable: false,
            } satisfies HarnessError, null, 2),
          },
        ],
        isError: true,
      };
  }
});

  return server;
}

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
/**
 * Map legacy medium values to new RuleMedium values.
 * Used for backward compat when tool input uses old enum values.
 */
const LEGACY_MEDIUM_MAP: Record<string, RuleMedium> = {
  "linter": "linter_warn",
  "settings.json": "settings",
  "claude.md": "claude_md",
};

function normalizeMediumInput(m: string): RuleMedium {
  return LEGACY_MEDIUM_MAP[m] ?? m as RuleMedium;
}

function enrichPartialDecisions(
  partials: Array<{ ruleId: string; recommendedMedium: RuleMedium }>,
): RuleDecision[] {
  const rules = loadRules();
  return partials.map((p) => {
    const rule = rules.find((r) => r.id === p.ruleId);
    const medium = normalizeMediumInput(p.recommendedMedium);
    if (!rule) {
      return {
        ruleId: p.ruleId,
        ruleName: p.ruleId,
        recommendedMedium: medium,
        alternativeMedia: [],
        confidence: 0.5,
        reasons: ["Rule definition not found"],
        cognitiveLayerRequired: false,
        cognitiveSkillTriggers: [],
      };
    }
    // Build meaningful reasons from rule definition attributes
    const reasons: string[] = [];
    if (rule.formalizable) {
      reasons.push("规则可形式化，适合自动化检查");
    } else {
      reasons.push("规则不可完全形式化，需要认知层支持");
    }
    reasons.push(`实施成本 ${rule.cost <= 2 ? "低" : rule.cost <= 3 ? "中" : "高"} (${rule.cost}/5)`);
    if (rule.frequency <= 2) {
      reasons.push(`触发频率低 (${rule.frequency}/5)`);
    } else if (rule.frequency >= 4) {
      reasons.push(`触发频率高 (${rule.frequency}/5)`);
    }
    if (!rule.formalizable) {
      reasons.push("建议配合认知层 Skills 使用");
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      recommendedMedium: medium,
      alternativeMedia: rule.alternativeMedium,
      confidence: 0.8,
      reasons,
      cognitiveLayerRequired: !rule.formalizable,
      cognitiveSkillTriggers: !rule.formalizable
        ? (rule.cognitiveLayerSupport?.skillTriggers ?? ["diagnostic", "educational"])
        : [],
      adjustedCost: rule.cost,
      adjustedCostLabel: rule.cost <= 2 ? "low" : rule.cost <= 3 ? "medium" : "high",
      feedbackSpeed: rule.feedbackSpeed,
      errorMessage: rule.errorMessage,
    };
  });
}

/**
 * Shared file generation logic used by both generate_config and init_harness.
 * Produces the core config files: CLAUDE.md, ESLint, settings.json, .gitignore.
 */
function generateProjectFiles(
  decisions: RuleDecision[],
  projectDir?: string,
): Array<{ path: string; content: string; action: "created" | "overwritten" | "skipped" | "merged" | "dry_run" }> {
  const files: Array<{ path: string; content: string; action: "created" | "overwritten" | "skipped" | "merged" | "dry_run" }> = [];

  // 1. CLAUDE.md
  files.push({ path: "CLAUDE.md", content: generateClaudeMd({ decisions }), action: "created" });

  // 2. ESLint config (if any linter_error or linter_warn rules)
  const linterDecisions = decisions.filter(
    (d) => d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter",
  );
  if (linterDecisions.length > 0) {
    files.push({ path: "eslint.config.js", content: generateEslintConfig({ decisions, projectDir }), action: "created" });
  }

  // 3. settings.json
  files.push({ path: ".claude/settings.json", content: generateSettingsJson({ decisions }), action: "created" });

  // 4. .gitignore true merge
  let existingGitignore: string | undefined;
  if (projectDir) {
    const gitignorePath = join(projectDir, ".gitignore");
    try {
      if (existsSync(gitignorePath)) {
        existingGitignore = readFileSync(gitignorePath, "utf-8");
      }
    } catch {
      // If reading fails, proceed without existing content
    }
  }
  const gitignoreAdditions = generateGitignore(existingGitignore);
  if (gitignoreAdditions.trim()) {
    const finalContent = existingGitignore
      ? `${existingGitignore.replace(/\n$/, "")}\n${gitignoreAdditions}`
      : gitignoreAdditions;
    files.push({ path: ".gitignore", content: finalContent, action: "merged" });
  } else if (existingGitignore) {
    // File exists but no new entries to add — still include it so backup/restore works
    files.push({ path: ".gitignore", content: existingGitignore, action: "skipped" });
  }

  // Note: lint-staged config is now merged into package.json (not a standalone file)

  return files;
}

/**
 * Backup existing generated files to .harness/backups/<timestamp>/.
 * Returns the backup directory path, or null if no files were backed up.
 */
function backupGeneratedFiles(projectDir: string): string | null {
  const candidates = [
    "CLAUDE.md",
    "eslint.config.js",
    ".claude/settings.json",
    ".husky/pre-commit",
    ".husky/commit-msg",
    ".github/workflows/ci.yml",
    ".gitignore",
    "package.json",
    ".lintstagedrc.json",
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

  console.error(`Backing up ${toBackup.length} files to ${backupDir}`);
  return backupDir;
}

// ============================================================
// Start (stdio transport)
// ============================================================

async function main() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Harness Automation MCP Server started on stdio");
}

// Only run main() when executed directly (not when imported by tests)
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
