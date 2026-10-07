# OMP profile for the Zijie-Tian fork

This branch adapts `Zijie-Tian/SoL-Pi`, based on `e1a586af0ad8956f42ae5b26bba20e48fbf30e00`, for OMP **18.6.1 and 18.7.0**. It does not patch OMP or an existing Pi installation. OMP-specific changes stay on the independent `tzj/omp-sol-pi-compat` branch, not the fork's default branch or its Pi-managed checkout.

## Supported and validated profile

- **Action Fusion**: native write and single-file edit, followed by a command in the same tool call.
- **ObservationPack**: two initial full sends, subsequent placeholders, append-only savings ledger, and exact paged recall. The original session history is retained.
- Evidence-Preserving Reducer and Online Context Compact stay **disabled**. They are not covered by this OMP profile; passing the Pi suite does not claim they work in OMP.

The owner explicitly selected this two-feature, user-wide profile rather than the upstream all-enabled Pi installation profile.

## Per-invocation token notifications

In interactive TUI mode, every actual placeholder replacement emits a notification, including subsequent requests reusing the same observation. Each notice identifies the observation and reports the **per-request** estimated input-token reduction, with original and placeholder counts. It is not a session total. The first two full sends and fail-open cases do not claim savings. The existing temporary footer status lasts four seconds; a later notification refreshes it.

Observation counts use the existing `ceil(text.length / 4)` estimator (JavaScript string length), not the selected model's tokenizer. The reported reduction subtracts the complete placeholder, including its instructions and excerpts, from the original estimate. These are context-size estimates, **not provider usage or billed-token savings**; caching and later recalls can change the net benefit.

Every successful fused write/edit command also emits a notification. It estimates the avoided input-context replay from the host's `getContextUsage().tokens` and labels the figure as a context-size estimate for one avoided model round-trip. The skipped request has no actual usage record; its output, subsequent tool-result overhead, and billing/cache effects are not measured. When the host has no usable token count, the notice explicitly says token savings are unavailable rather than inventing a number. Failed commands keep their normal error output and do not announce successful savings.

Every successful `obs_recall` emits its own notification and reports **zero tokens saved**, plus the estimated input tokens added by the returned page and header. Recall results expose this estimate as `details.recalledTokens` for their tool renderer. This avoids presenting retrieval as another compression saving. Do not add fusion estimates and placeholder reductions into one claimed savings total.

Notifications remain TUI-only; JSON, print, and RPC modes keep working without UI messages. Restart an already-running OMP session to load changes to the linked source. No reinstall is required.

## Install from a local branch

Use a separate clone of the user's fork; do not reuse or reset an existing Pi-managed working tree. In the intended branch checkout:

```sh
npm ci --ignore-scripts
npm audit --audit-level=high
npm run check
node scripts/check-pi-compat.mjs
node scripts/check-omp.mjs
omp plugin link "$PWD" --scope user
omp plugin list --json
```

Place this user-level configuration at the agent directory reported by OMP (normally `~/.omp/agent/sol-pi.json`):

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Validate the configuration and automatic discovery:

```sh
node scripts/check-sol-pi-config.mjs --config ~/.omp/agent/sol-pi.json
node scripts/check-omp.mjs --installed
```

Do not pass `--require-all-enabled` for this explicitly selected profile. Restart existing OMP sessions after installing or modifying the linked extension. A local link uses the branch's current working tree, including uncommitted changes; it does not publish a branch or install an immutable commit.

## Compatibility changes

1. OMP provides ArkType tool schemas; Pi provides TypeBox schemas. Fusion converts the former to JSON Schema without dropping native parameters or changing which parameters are required. `then_run` remains optional.
2. OMP's edit tool uses hashline `input`, not Pi's `path`/replacement parameters. A fused edit extracts its one `[PATH#TAG]` header for the existing per-file lock and hash check. Ordinary multi-file edits are delegated untouched when `then_run` is absent. Multi-file **fused** edits are rejected before mutation. Fusion is intended for regular filesystem files, not OMP virtual database/archive edits, renames, or deletions.
3. A host may return `isError: true` instead of throwing. A failed mutation must skip the command; a failed command must report `[then_run:failed]` while retaining the successful mutation. Both paths are checked.
4. Test dependencies use Pi **1.0.4**, Vitest **4.1.11**, and `source-map-js` **1.2.2**. Pi 0.85.1's published shrinkwrap prevented top-level overrides from replacing its vulnerable nested dependencies; no published Pi files were patched. The full Pi regression suite was rerun after the upgrade.

## Verification

`check-omp.mjs` starts the actual OMP executable with a deterministic local provider, not a mocked extension API. It performs ten provider requests through OMP's normal tool execution and context projection:

- fused write and native hashline edit;
- unsuccessful command preserves the written file;
- unsuccessful mutation never executes the follow-up command;
- large read is preserved on two requests, then packed;
- recall bytes equal the archived slice exactly;
- original tool output in the session equals the archive;
- savings ledger contains full, placeholder, and recall events.

The default invocation uses an isolated agent directory and an explicit extension path. `--installed` uses user-level discovery, proving the installed plugin is actually active. Temporary evidence directories are printed and retained. A user's optional post-run memory-capture request is answered without tools. No paid provider calls are made by this script.

Initial integration validation on 2026-10-07: Node 24.15.0, OMP 18.6.1, 202 Pi tests across 22 files, type checking, public API check, npm audit (zero vulnerabilities), isolated and installed OMP integration tests, and transcript rendering. A separate live `openai-codex/gpt-6-astra` request invoked `write` with `then_run`, produced the expected verification file, and returned `OK` with no tool error. Live inference is not part of the repeatable offline script.

The per-invocation notification update was additionally verified on OMP 18.7.0: type checking, 201 tests across 22 files, package dry-run, public API compatibility, and the ten-request installed-discovery integration run passed. An actual interactive OMP process in a pseudoterminal, using the same deterministic local provider, visibly rendered fusion estimates, repeated placeholder-saving notices, and recall costs. A repeated-context smoke changed notification totals from `0, 0, 1, 1, 1` before the update to `0, 0, 1, 2, 3` afterward. No real-model savings or invoice reduction was measured in this validation.

Limits: this is not a cross-platform or all-model compatibility claim. Future OMP schema/API changes require rerunning the host test. This profile makes no benchmark or monetary-savings claim.
