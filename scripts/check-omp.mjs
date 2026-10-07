#!/usr/bin/env node
// Run actual OMP with a deterministic local provider; no paid model requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installed = process.argv.includes("--installed");
const root = mkdtempSync(join(tmpdir(), "sol-pi-omp-smoke-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
mkdirSync(agentDir);
mkdirSync(sessionDir);
writeFileSync(join(agentDir, "sol-pi.json"), JSON.stringify({
  version: 1, actionFusion: true, observationPack: true,
  evidencePreservingReducer: false, onlineContextCompact: false,
}));
writeFileSync(join(root, "large.txt"), Array.from({ length: 180 }, (_, i) =>
  `OMP_OBSERVATION_LINE_${String(i).padStart(4, "0")} ${"evidence ".repeat(10)}\n`).join(""));
const env = { ...process.env, OMP_PROFILE: "", PI_PROFILE: "", SOL_PI_OMP_SMOKE_DIR: root };
if (installed) delete env.PI_CODING_AGENT_DIR;
else env.PI_CODING_AGENT_DIR = agentDir;
const args = ["--mode", "json", "--no-title", "--no-lsp", "--no-skills", "--no-rules", "--no-pty",
  "--session-dir", sessionDir, "--approval-mode", "yolo",
  "--tools", "read,bash,edit,write", "--model", "sol-pi-omp-smoke/scripted",
  "--system-prompt", "Execute the deterministic local integration test."];
if (!installed) args.push("--no-extensions", "-e", fileURLToPath(new URL("../src/sol-pi/index.ts", import.meta.url)));
args.push("-e", fileURLToPath(new URL("./omp-smoke-provider.ts", import.meta.url)), "-p", "Run the integration test.");
const run = spawnSync(process.env.OMP_BIN || "omp", args, { cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
writeFileSync(join(root, "stdout.jsonl"), run.stdout ?? "");
writeFileSync(join(root, "stderr.log"), run.stderr ?? "");
console.log(`OMP validation artifacts: ${root}`);
if (existsSync(join(root, "failure.txt"))) console.error(readFileSync(join(root, "failure.txt"), "utf8"));
assert.ifError(run.error);
assert.equal(existsSync(join(root, "failure.txt")), false, "Deterministic provider assertions failed");
assert.equal(run.status, 0, `OMP exited ${run.status}; inspect ${root}/stderr.log`);
assert.ok(existsSync(join(root, "result.json")), `Provider assertions did not finish; inspect ${root}/stdout.jsonl`);
const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
const observationDir = join(result.sessionDir, "sol-pi", result.sessionId, "observation-pack");
const ledger = readFileSync(join(observationDir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const events = ledger.filter((entry) => entry.id === result.observationId);
assert.equal(events.filter((entry) => entry.event === "full").length, 2);
assert.ok(events.some((entry) => entry.event === "placeholder" && entry.removedTokens > 0));
assert.ok(events.some((entry) => entry.event === "recall"));
const archived = readFileSync(join(observationDir, "objects", `${result.observationId}.txt`), "utf8");
assert.ok(archived.includes("OMP_OBSERVATION_LINE_0090"));
const transcript = (run.stdout ?? "").split("\n").flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const text = (message) => (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const original = transcript.find((entry) => entry.type === "message_end" && entry.message?.role === "toolResult" && entry.message.toolCallId === "omp-smoke-5");
assert.equal(text(original?.message), archived, "Stored history must retain the complete original observation");
const recalled = transcript.find((entry) => entry.type === "message_end" && entry.message?.role === "toolResult" && entry.message.toolCallId === "omp-smoke-8");
const recallEvent = events.find((entry) => entry.event === "recall");
assert.equal(text(recalled?.message).split("\n").slice(2).join("\n"), Buffer.from(archived).subarray(0, recallEvent.bytes).toString("utf8"));
console.log(JSON.stringify({ ...result, installedDiscovery: installed, ledgerVerified: true, exactRecallVerified: true, originalHistoryPreserved: true, artifactDir: root }, null, 2));
