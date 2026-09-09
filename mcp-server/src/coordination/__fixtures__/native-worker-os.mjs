import "../../credentials/__fixtures__/host-os.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
// Match this suite's macOS resolver boundary on every supported POSIX CI host.
Object.defineProperty(process, "platform", { ...Object.getOwnPropertyDescriptor(process, "platform"), value: "darwin" });
// Standalone CLI children do not inherit Vitest mocks. Propagate only this test's OS/artifact seam.
const nativeSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (!args?.some((arg) => arg.endsWith("/client_worker.ts"))) return nativeSpawn(command, args, options);
  return nativeSpawn(command, ["--loader", fileURLToPath(new URL("./native-worker-loader.mjs", import.meta.url)),
    "--import", fileURLToPath(import.meta.url), ...args],
  { ...options, env: { ...options?.env, HARNESS_FIXTURE_USER_ROOT: process.env.HARNESS_FIXTURE_USER_ROOT, TSX_DISABLE_CACHE: "1" } });
};
syncBuiltinESMExports();
