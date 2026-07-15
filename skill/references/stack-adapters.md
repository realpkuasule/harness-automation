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

If discovery returns `custom`, do not silently choose. Ask the owner for the intended architecture. v2 supports one of the three profiles above as the compilation baseline; unsupported stacks require an explicit adapter design and must report unavailable enforcement as `blocked`.
