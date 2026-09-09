import { createRequire, register } from "node:module";
import { MessageChannel, type MessagePort } from "node:worker_threads";

// Source execution only. Resolve the exact compiler used by tsx, including nested installs.
function stopCompiler(): Promise<void> {
  const require = createRequire(import.meta.url);
  return require(createRequire(require.resolve("tsx")).resolve("esbuild")).stop();
}

/** Node invokes this in the loader realm which owns tsx's asynchronous compiler service. */
export async function initialize({ port }: { port: MessagePort }): Promise<void> {
  await stopCompiler(); port.postMessage("compiler-stopped"); port.close();
}

export async function stopSourceLoader(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  const stopped = new Promise<void>((resolve) => port1.on("message", (message: unknown) => {
    if (message === "compiler-stopped") resolve();
  }));
  try {
    register(import.meta.url, { data: { port: port2 }, transferList: [port2] });
    await stopped;
    // CJS transforms can also own a compiler in the application realm.
    await stopCompiler();
  } finally { port1.close(); port2.close(); }
}
