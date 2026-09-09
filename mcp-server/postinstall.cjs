const fs = require("node:fs");

const message = `Harness Automation v${require("./package.json").version} installed\n`;
process.stdout.write(message);

if (!process.stdout.isTTY) {
  const terminal = process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty";
  try {
    fs.writeFileSync(terminal, message);
  } catch {}
}
