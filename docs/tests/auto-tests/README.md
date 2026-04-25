# Harness Automation — Automated Test Plan

## Overview

Existing: 93 tests, 9 files, all passing.
Target: systematic coverage of all modules with clear priorities.

## Quick Start

```bash
npm test                    # run all
npx vitest run --coverage   # with coverage
npx vitest run src/index.test.ts  # single file
```

## Coverage Targets (vitest.config.ts)

```typescript
coverage: {
  thresholds: {
    branches: 80,
    functions: 85,
    lines: 85,
    statements: 85,
  },
},
```

## File Index

| File | Priority | What It Tests |
|------|----------|---------------|
| `01-server.test.ts` | P0 | All 18 MCP tool handlers |
| `02-state-machine.test.ts` | P1 | HarnessStatus state transitions |
| `03-generators-content.test.ts` | P1 | Semantic correctness of generated configs |
| `04-engine-combinatorial.test.ts` | P2 | 3×3×5+ engineering input combinations |
| `05-adapter-thresholds.test.ts` | P2 | Bypass/fix rate threshold logic |
| `06-io-roundtrip.test.ts` | P2 | Export → import → verify roundtrip |
| `07-scanner-fixtures.test.ts` | P3 | Real code samples in __fixtures__/ |
| `08-deps-edge-cases.test.ts` | P3 | Dependency checking edge cases |
| `09-performance-baselines.test.ts` | P3 | Rule loading, scan throughput baselines |
| `10-index-cover.test.ts` | P0 | Remove index.ts from coverage exclusion |

Total estimate: ~220-280 new tests, ~2-3 days.
