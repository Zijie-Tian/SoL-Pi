/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Base pi rollouts repeatedly showed the same pair of turns: edit or write a
 * file, then run a command to test, build, or start it. This extension replaces
 * the built-in `edit` and `write` tools with versions that take an optional
 * `then_run` object, apply the mutation, run the command, and return one
 * combined observation. The model decision between the two turns disappears.
 *
 * Everything else about `edit` and `write` is inherited from the built-in
 * definitions: their schemas, prompt text, argument shims, and renderers.
 *
 * This standalone version composes only Pi's public tool definitions.
 */

import {
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { resolveToolPath } from "./file-queue.ts";
import { fusedEditPath, withThenRun } from "./host-schema.ts";
import { formatSavingsCount, renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import {
	executeMutationThenRun,
	THEN_RUN_SUCCEEDED,
	type ThenRunInput,
} from "./then-run.ts";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

export interface ActionFusionOptions {
	/** Optional programmatic bash overrides, primarily for tests and embedded runtimes. */
	readonly bashOptions?: BashToolOptions;
	/** Overrides for the underlying built-in `edit` tool. */
	readonly editOptions?: EditToolOptions;
	/** Overrides for the underlying built-in `write` tool. */
	readonly writeOptions?: WriteToolOptions;
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

function showFusionSavings(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	// The skipped provider request has no usage record. Its replay cost can only
	// be estimated from the current context, not reported as billed-token savings.
	const tokens = ctx.getContextUsage()?.tokens;
	const saving = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
		? `approximately ${formatSavingsCount(tokens, "input tokens of context replay avoided")}; 1 model round-trip (context-size estimate)`
		: "token savings unavailable; 1 model round-trip avoided";
	showSolPiSavings(ctx, "Action Fusion", saving);
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd, options.editOptions));
	const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd, options.writeOptions));

	return (pi: ExtensionAPI) => {
		const editTemplate = baseEdit(process.cwd());
		const writeTemplate = baseWrite(process.cwd());

		const editParameters = withThenRun(editTemplate.parameters, EDIT_THEN_RUN_DESCRIPTION);
		const writeParameters = withThenRun(writeTemplate.parameters, WRITE_THEN_RUN_DESCRIPTION);

		pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
			...editTemplate,
			parameters: editParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				// Preserve OMP's native multi-file edit when fusion was not requested.
				if (!then_run && typeof input.path !== "string") {
					return baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx);
				}
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: fusedEditPath(ctx.cwd, input),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showFusionSavings(ctx);
				}
				return result;
			},
			renderCall: (args, theme, context) => {
				const base = baseEdit(context.cwd).renderCall!(args, theme, context);
				return args.then_run ? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base) : base;
			},
			renderResult: (result, resultOptions, theme, context) => {
				const base = baseEdit(context.cwd).renderResult!(result, resultOptions, theme, context);
				return context.args.then_run
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
		});

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			parameters: writeParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showFusionSavings(ctx);
				}
				return result;
			},
			renderCall: (args, theme, context) => {
				const base = baseWrite(context.cwd).renderCall!(args, theme, context);
				return args.then_run ? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base) : base;
			},
			renderResult: (result, resultOptions, theme, context) => {
				const base = baseWrite(context.cwd).renderResult!(result, resultOptions, theme, context);
				return context.args.then_run
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
		});
	};
}

export type { ThenRunInput } from "./then-run.ts";
export {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "./then-run.ts";

export function registerActionFusion(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}

export default registerActionFusion;
