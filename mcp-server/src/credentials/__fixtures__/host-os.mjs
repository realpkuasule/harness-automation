// Native-OS boundary fixture, explicitly preloaded by tests; never imported by production.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
if (!process.env.HARNESS_FIXTURE_USER_ROOT) throw new Error("FIXTURE_HOST_REQUIRED");
os.homedir = () => process.env.HARNESS_FIXTURE_USER_ROOT;
syncBuiltinESMExports();
