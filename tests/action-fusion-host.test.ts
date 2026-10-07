/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Type, type TSchema } from "typebox";
import { fusedEditPath, withThenRun } from "../src/sol-pi/extensions/action-fusion/host-schema.ts";
import { executeMutationThenRun } from "../src/sol-pi/extensions/action-fusion/then-run.ts";
import { fakeContext } from "./helpers.ts";

const jsonSchema = (value: TSchema) => value as unknown as {
	properties: Record<string, unknown>; required: string[]; additionalProperties?: boolean;
};

describe("Action Fusion host compatibility", () => {
	it("preserves Pi's required and optional parameters", () => {
		const base = Type.Object({ path: Type.String(), content: Type.String(), optional: Type.Optional(Type.Boolean()) });
		const schema = jsonSchema(withThenRun(base, "follow-up command"));
		expect(schema.required).toEqual(["path", "content"]);
		expect(Object.keys(schema.properties)).toEqual(["path", "content", "optional", "then_run"]);
	});

	it("converts OMP's native schema before adding then_run", () => {
		const base = { toJsonSchema: () => ({ type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }) };
		const schema = jsonSchema(withThenRun(base as unknown as TSchema, "follow-up command"));
		expect(schema.properties.input).toEqual({ type: "string" });
		expect(schema.properties.then_run).toBeDefined();
		expect(schema.required).toEqual(["input"]);
		expect(schema.additionalProperties).toBe(false);
	});

	it("rejects unsupported host schemas instead of silently dropping fields", () => {
		expect(() => withThenRun({} as TSchema, "command")).toThrow("object-shaped");
	});

	it("uses Pi's path or one OMP hashline header for the file lock", () => {
		const cwd = tmpdir();
		expect(fusedEditPath(cwd, { path: "one.txt" })).toBe(join(cwd, "one.txt"));
		expect(fusedEditPath(cwd, { input: "[space # file.txt#A1b2]\nPUT 1.=1:\n+replacement" })).toBe(join(cwd, "space # file.txt"));
	});

	it("rejects missing and multi-file hashline headers before fused mutation", () => {
		for (const input of ["PUT 1.=1:\n+replacement", "[a.txt#1234]\nPUT 1.=1:\n+a\n[b.txt#5678]\nPUT 1.=1:\n+b"]) {
			expect(() => fusedEditPath(tmpdir(), { input })).toThrow("[then_run:skipped]");
		}
	});

	it("does not run a command after a host returns an error result", async () => {
		const exec = vi.fn();
		await expect(executeMutationThenRun({
			toolCallId: "native-error", absolutePath: join(tmpdir(), "sol-pi-native-error.txt"),
			thenRun: { command: "must not run" }, bashOptions: { operations: { exec } },
			signal: undefined, ctx: fakeContext(tmpdir()),
			mutate: async () => ({ content: [{ type: "text", text: "native mutation failed" }], details: undefined, isError: true }),
		})).rejects.toThrow("native mutation failed\n\n[then_run:skipped]");
		expect(exec).not.toHaveBeenCalled();
	});

	it("preserves native error results when fusion was not requested", async () => {
		const error = { content: [{ type: "text" as const, text: "native mutation failed" }], details: undefined, isError: true };
		const result = await executeMutationThenRun({
			toolCallId: "ordinary-error", absolutePath: join(tmpdir(), "sol-pi-native-error.txt"),
			thenRun: undefined, bashOptions: undefined, signal: undefined, ctx: fakeContext(tmpdir()), mutate: async () => error,
		});
		expect(result).toBe(error);
	});
});
