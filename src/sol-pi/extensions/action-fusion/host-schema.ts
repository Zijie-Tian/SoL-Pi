/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { Type, type Static, type TSchema } from "typebox";
import { resolveToolPath } from "./file-queue.ts";
import { createThenRunSchema, THEN_RUN_SKIPPED, type ThenRunInput } from "./then-run.ts";

/** OMP supplies ArkType schemas; Pi supplies TypeBox JSON schemas. Keep the host's required fields. */
export function withThenRun<T extends TSchema>(parameters: T, description: string) {
	const native = parameters as T & { toJsonSchema?: () => unknown };
	const schema = (typeof native.toJsonSchema === "function" ? native.toJsonSchema() : parameters) as {
		type?: string;
		properties?: Record<string, unknown>;
		[key: string]: unknown;
	};
	if (schema.type !== "object" || !schema.properties) {
		throw new Error("Action Fusion requires an object-shaped host tool schema");
	}
	return Type.Unsafe<Static<T> & { then_run?: ThenRunInput }>({
		...schema,
		properties: { ...schema.properties, then_run: createThenRunSchema(description) },
	});
}

/** A fused OMP hashline edit must address one ordinary file so its mutation can be locked and verified. */
export function fusedEditPath(cwd: string, input: { path?: string; input?: string }): string {
	if (typeof input.path === "string") return resolveToolPath(cwd, input.path);
	const headers = [...(input.input ?? "").matchAll(/^\[([^\r\n]+)#[a-f0-9]{4}\]\s*$/gim)];
	if (headers.length !== 1) {
		throw new Error(`${THEN_RUN_SKIPPED} Fused hashline edits require exactly one [PATH#TAG] header; use an ordinary edit for multiple files.`);
	}
	return resolveToolPath(cwd, headers[0]![1]!);
}
