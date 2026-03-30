import { afterEach, describe, expect, it } from "vitest";
import { promptAskUser, setAskUserInteractionHandler } from "./interaction.js";

describe("ask-user interaction", () => {
	afterEach(() => {
		setAskUserInteractionHandler(null);
	});

	it("hard-fails when no interaction handler is installed", async () => {
		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk, encoding, callback) => {
			writes.push(
				typeof chunk === "string"
					? chunk
					: Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : undefined),
			);
			const done: ((err?: Error | null) => void) | undefined = typeof encoding === "function" ? encoding : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write;

		await expect(
			promptAskUser({
				mode: "clarify",
				objective: "Lock down missing validation details",
				scopeName: "login-flow",
				questions: [
					{
						id: "surface",
						topic: "Surface",
						prompt: "Which surface should verify the flow?",
						options: ["xtui", "cdp"],
					},
				],
			}),
		).rejects.toThrow("ask_user requires an interactive handler");

		process.stdout.write = originalWrite;
		expect(writes).toEqual([]);
	});

	it("uses the installed interaction handler when available", async () => {
		setAskUserInteractionHandler(async () => ({
			scopeName: "login-flow",
			sanitizedScopeName: "login-flow",
			answers: [
				{
					questionId: "surface",
					topic: "Surface",
					prompt: "Which surface should verify the flow?",
					answer: "xtui",
					source: "option",
				},
			],
			files: [],
			summary: "1. Surface: xtui",
		}));

		await expect(
			promptAskUser({
				mode: "clarify",
				objective: "Lock down missing validation details",
				scopeName: "login-flow",
				questions: [
					{
						id: "surface",
						topic: "Surface",
						prompt: "Which surface should verify the flow?",
						options: ["xtui", "cdp"],
					},
				],
			}),
		).resolves.toMatchObject({
			scopeName: "login-flow",
			answers: [{ answer: "xtui" }],
		});
	});
});
