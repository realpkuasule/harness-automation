// Test-only equivalent of the native-command suite's currentHarnessArtifact mock.
// All credential/Broker/Git/IPC/process-group behavior stays on its real implementation.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/repository/artifact.ts")) return { format: "module", shortCircuit: true,
    source: `export * from ${JSON.stringify(`${url}?native-fixture-original`)};export function currentHarnessArtifact(){return {implementation:{kind:'package',artifactDigest:'a'.repeat(64)},runnerHash:'a'.repeat(64)}}` };
  return nextLoad(url, context);
}
