# Credential registration (v3 development)

Registration records non-secret credential references, not tokens. It does not
prove access, enable coordination, configure a Reviewer, or create GitHub rules.
The current OS resolver supports macOS Keychain; other platforms fail explicitly.

1. Prepare a non-secret JSON binding with `schemaVersion: credential-host-binding/1.0`,
   canonical Git `commonDir`, actual `hostId`, `repository`, immutable `repositoryId`,
   SHA-256 `endpointHash` of the unique resolved push URL, and `credentials`.
   Each credential includes `id`, `purpose`, `hostId`, `repository`, expected GitHub
   `identity`, permission-summary `scopes`, `expiresAt`, `envVar`, and exact
   `keychainService` / `keychainAccount`. Never put a token in this file.
2. Run `harness-automation credentials plan --project . --input <binding.json>`.
   Review its readable approval packet. Plans expire after 15 minutes.
3. With explicit approval, run `harness-automation credentials apply --project .
   --plan <returned-plan-path> --approve <exact-plan-hash>`.

Purposes and environment names are fixed: `git-transport` uses
`HARNESS_GIT_TOKEN`; `github-api` and `github-admin` use `GH_TOKEN`; `reviewer`
uses `HARNESS_REVIEWER_TOKEN` but remains blocked by DG-02. Separate purposes do
not inherit another purpose's permission. `scopes` is descriptive, never proof.

The approved receipt/LKG chain under the Git common-dir is authoritative. The
owner-only `harness/credentials/host-binding.json` is a recoverable projection;
handwriting it grants nothing. Same-plan retry repairs a missing projection;
replacement requires a new plan bound to current state. Expired credentials do
not prevent their explicitly approved replacement.

On use, the Broker validates metadata before secret resolution, rechecks the
registered binding, probes actual actor and immutable repository ID, and uses a
fixed API endpoint for each read capability. A metadata response or OAuth scope
header does not prove code access or write permission. Secrets and reversible
Git Basic values stay out of argv and are scrubbed from transport output/errors.
No global login, SSH fallback, token creation, or permission escalation occurs.

Validation: `cd mcp-server && npx vitest run src/credentials` exercises disposable
Git repositories and synthetic Keychain/`gh` subprocesses. These are LOCAL tests,
not evidence of a real credential registration or GitHub LIVE qualification.
