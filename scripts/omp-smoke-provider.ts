// Deterministic provider for check-omp.mjs. No network or real model credentials.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
	const root = process.env.SOL_PI_OMP_SMOKE_DIR;
	assert.ok(root, "Run through scripts/check-omp.mjs");
	let step = 0;
	let editHeader = "";
	let storage: { sessionDir: string; sessionId: string };
	const evidence: Record<string, unknown> = {};
	const text = (message: any) => typeof message?.content === "string" ? message.content :
		(message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
	pi.on("session_start", (_event: unknown, ctx: any) => {
		storage = { sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId() };
	});
	pi.registerProvider("sol-pi-omp-smoke", {
		api: "sol-pi-omp-smoke", baseUrl: "http://127.0.0.1:1", apiKey: "local-test-only",
		models: [{ id: "scripted", name: "SoL-Pi deterministic OMP test", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
		streamSimple(model: any, context: any) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					const last = [...context.messages].reverse().find((item: any) => item.role === "toolResult");
					const call = (name: string, args: any) => {
						message.content = [{ type: "toolCall", id: `omp-smoke-${step}`, name, arguments: args }];
						message.stopReason = "toolUse";
					};
					const edit = (oldText: string, newText: string, command: string) => {
						const schema = context.tools.find((tool: any) => tool.name === "edit").parameters;
						call("edit", {
							...(schema.properties.input
								? { input: `${editHeader}\nPUT 1.=1:\n+${newText}` }
								: { path: join(root, "target.txt"), ...(schema.properties.edits ? { edits: [{ oldText, newText }] } : { oldText, newText }) }),
							then_run: { command } });
					};
					switch (step) {
						case 0:
							for (const name of ["write", "edit"]) {
								const tool = context.tools.find((tool: any) => tool.name === name);
								assert.ok(tool?.parameters?.properties?.then_run, `${name} must expose then_run`);
							}
							assert.ok(context.tools.some((tool: any) => tool.name === "obs_recall"));
							call("write", { path: join(root, "target.txt"), content: "alpha\n",
								then_run: { command: "test \"$(cat target.txt)\" = alpha && printf ok > write.ok" } });
							break;
						case 1:
							assert.match(text(last), /\[then_run:succeeded\]/);
							assert.ok(existsSync(join(root, "write.ok")));
							evidence.fusedWrite = true;
							call("read", { path: join(root, "target.txt") });
							break;
						case 2:
							editHeader = text(last).match(/\[[^\r\n]+#[a-f0-9]{4}\]/i)?.[0] ?? "";
							edit("alpha", "beta", "test \"$(cat target.txt)\" = beta && printf ok > edit.ok");
							break;
						case 3:
							assert.match(text(last), /\[then_run:succeeded\]/);
							assert.ok(existsSync(join(root, "edit.ok")));
							evidence.fusedEdit = true;
							call("write", { path: join(root, "preserved.txt"), content: "preserved\n",
								then_run: { command: "printf intentional-command-failure; exit 7" } });
							break;
						case 4:
							assert.equal(last.isError, true);
							assert.match(text(last), /\[then_run:failed\]/);
							assert.equal(readFileSync(join(root, "preserved.txt"), "utf8"), "preserved\n");
							evidence.failedCommandPreservesMutation = true;
							edit("missing-original-text", "never", "printf unsafe > must-not-exist");
							break;
						case 5:
							assert.equal(last.isError, true);
							assert.match(text(last), /\[then_run:skipped\]/);
							assert.equal(existsSync(join(root, "must-not-exist")), false);
							assert.equal(readFileSync(join(root, "target.txt"), "utf8"), "beta\n");
							evidence.failedMutationSkipsCommand = true;
							call("read", { path: join(root, "large.txt") });
							break;
						case 6:
						case 7: {
							const observation = context.messages.find((item: any) => item.role === "toolResult" && item.toolCallId === "omp-smoke-5");
							assert.match(text(observation), /OMP_OBSERVATION_LINE_0090/);
							assert.doesNotMatch(text(observation), /large tool result replaced/);
							call("bash", { command: "printf continue" });
							break;
						}
						case 8: {
							const observation = context.messages.find((item: any) => item.role === "toolResult" && item.toolCallId === "omp-smoke-5");
							const packed = text(observation);
							assert.match(packed, /large tool result replaced after its first 2 provider requests/);
							assert.doesNotMatch(packed, /OMP_OBSERVATION_LINE_0090/);
							const id = packed.match(/id: (obs_[a-f0-9]{24})/)?.[1];
							assert.ok(id);
							evidence.packedAfterTwoRequests = true;
							evidence.observationId = id;
							call("obs_recall", { id });
							break;
						}
						case 9:
							assert.notEqual(last.isError, true);
							assert.match(text(last), /OMP_OBSERVATION_LINE_0090/);
							evidence.exactRecall = true;
							writeFileSync(join(root, "result.json"), JSON.stringify({ ...evidence, ...storage, requests: step + 1 }, null, 2));
							message.content = [{ type: "text", text: "SOL_PI_OMP_SMOKE_OK" }];
							break;
						default: {
							// A user's OMP settings may request one post-run memory-capture turn.
							const tail = context.messages.at(-1);
							assert.equal(tail?.role, "developer", "Unexpected extra provider request");
							assert.match(text(tail), /^Automated capture turn/);
							message.content = [{ type: "text", text: "No reusable information to retain." }];
							break;
						}
					}
					step++;
					stream.push({ type: "start", partial: message });
					for (const [contentIndex, part] of message.content.entries()) {
						if (part.type === "toolCall") {
							stream.push({ type: "toolcall_start", contentIndex, partial: message });
							stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(part.arguments), partial: message });
							stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
						} else {
							stream.push({ type: "text_start", contentIndex, partial: message });
							stream.push({ type: "text_delta", contentIndex, delta: part.text, partial: message });
							stream.push({ type: "text_end", contentIndex, content: part.text, partial: message });
						}
					}
					stream.push({ type: "done", reason: message.stopReason, message });
				} catch (error) {
					message.stopReason = "error";
					message.errorMessage = `OMP smoke step ${step}: ${error instanceof Error ? error.stack : error}`;
					writeFileSync(join(root, "failure.txt"), message.errorMessage);
					stream.push({ type: "error", reason: "error", error: message });
				}
				stream.end();
			});
			return stream;
		},
	});
}
