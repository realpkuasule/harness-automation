// Test-only IPC/OS process-tree peer. Not a native identity, credential, Git or qualification attestation.
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
const [root, , , , nonce] = process.argv.slice(2);
const mode = basename(root); const digest = "a".repeat(64);
process.on("disconnect", () => process.exit(1));
process.on("message", (message) => {
  if (message.type === "step") {
    if (["descendant", "orphan", "residual"].includes(mode)) {
      const script = `const fs=require('node:fs');const end=Date.now()+8000;const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])||Date.now()>end){clearInterval(timer);process.exit(0)}},20);`;
      spawn(process.execPath, ["-e", script, join(root, "release")], { stdio: "ignore" }).unref();
    }
    process.send({ type: "result", nonce, stepId: message.stepId, resultHash: digest });
    if (mode === "orphan") process.exit(1);
  } else if (message.type === "stop") process.send({ type: "quiescent", nonce });
  else if (message.type === "exit") process.exit(0);
});
process.send({ type: "ready", nonce: mode === "wrong-nonce" ? "00000000-0000-4000-8000-000000000000" : nonce, pid: process.pid, bindingHash: digest });
