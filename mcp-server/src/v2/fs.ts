import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fileHash(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

export function safePath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error(`Unsafe repository path: ${relativePath}`);
  }
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  const back = relative(resolvedRoot, target);
  if (back.startsWith("..") || isAbsolute(back)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  let current = resolvedRoot;
  for (const segment of relativePath.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`SYMLINK_TARGET_REJECTED: ${relativePath} traverses ${current}`);
    }
  }
  return target;
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.harness-${process.pid}-${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx");
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function assertCurrentHash(path: string, expected: string | null): void {
  const actual = fileHash(path);
  if (actual !== expected) {
    throw new Error(
      `STALE_PRECONDITION: ${path} expected ${expected ?? "absent"}, found ${actual ?? "absent"}`,
    );
  }
}

export function withoutHash<T extends { planHash: string }>(value: T): Omit<T, "planHash"> {
  const copy = { ...value };
  delete (copy as Partial<T>).planHash;
  return copy;
}
