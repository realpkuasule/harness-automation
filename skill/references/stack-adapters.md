# Stack adapters and naming boundaries

## Full TypeScript

Profile: `full-typescript` — NestJS + Prisma + tRPC + Next.js.

- TypeScript variables, functions, parameters, methods and tRPC procedures: `camelCase`.
- Classes, types, interfaces, enums, React components and NestJS providers: `PascalCase`.
- Module constants only: `UPPER_SNAKE_CASE`.
- External JSON: `camelCase`.
- PostgreSQL: `snake_case`, mapped explicitly with Prisma `@map` and `@@map`.
- Generated Prisma artifacts are immutable.

The built-in TypeScript ESTree verifier enforces code identifiers. Prisma and boundary mapping require schema validation plus review until a sound schema-specific verifier is compiled.

## Python data and AI

Profile: `python-data-ai` — Django + Pydantic + PostgreSQL + Celery + React/TypeScript + K8s.

- Python variables, functions, parameters, modules and internal fields: `snake_case`.
- Python classes: `PascalCase`; constants: `UPPER_SNAKE_CASE`.
- TypeScript and external JSON: `camelCase`.
- Pydantic aliases are the translation point between Python and JSON.
- Django/PostgreSQL identifiers: `snake_case`.

Harness ships a Python standard-library AST checker and self-tests it with an invalid fixture. Migrations and generated code are excluded.

## Go performance

Profile: `go-performance` — Go + sqlc/ent + PostgreSQL + gRPC + K8s + TypeScript frontend.

- Go source: idiomatic `mixedCaps`; exported identifiers start uppercase, unexported identifiers lowercase.
- Proto fields and PostgreSQL columns: `snake_case`.
- Protobuf JSON and TypeScript: `camelCase`.
- Generated `.pb.go`, sqlc and ent output are immutable.

Harness ships a Go standard-library AST checker and self-tests it with an invalid fixture. Proto/SQL mapping remains schema validation plus contract review.

## Ambiguous repositories

If discovery returns `custom`, do not silently choose the nearest preset. Ask the owner to approve the exact stack identifiers. Use lowercase kebab-case such as `typescript`, `csharp`, `godot`, or `rust`.

Compile custom repositories with repeated `--stack` arguments, for example:

```bash
harness-automation plan --project . --profile custom --stack typescript
harness-automation plan --project . --profile custom --stack csharp --stack godot
```

Built-in adapters currently exist for `typescript`, `python`, `go`, `postgresql`, `grpc`, and `kubernetes`. Language naming gates and Kubernetes guidance are selected by stack. Framework-specific policies remain exclusive to their complete presets, so `custom + typescript` does not add NestJS, Prisma, tRPC, Next.js, or PostgreSQL.

A selected stack that discovery did not observe is allowed only as an explicit owner decision and appears as a plan warning. A stack without a built-in adapter remains in the compiled policy: generic continuity, source approval, immutable planning, drift, and rollback still work, while `check.stackAdapters` reports stack-specific enforcement as `blocked`.

Do not solve missing adapter coverage by replacing Harness with a second repository-local governance lifecycle. Put approved stack-specific guidance outside the Harness-managed block in `AGENTS.md`; the plan preserves and hashes the complete resulting file. Expose deterministic project checks through conventional package scripts:

- commit gates: `verify:*`, `*:check`, `lint`, `typecheck`, `format:check`;
- CI gates: `test`, `test:*`, `build`, `build:*`.

Harness discovers these commands as argv and includes them in the reviewed plan. A future built-in adapter may replace the blocked coverage without changing the project’s approval or rollback model.
