import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { describe, expect, test, vi } from "vitest";
import { SlashCommands } from "../src/experimental/services/slash-commands.ts";
import {
	createSlashCommandsRuntimeFacet,
	SlashCommandRegistry,
} from "../src/experimental/services/slash-commands-provider.ts";

describe("experimental slash command facets", () => {
	test("registers and removes contributions", () => {
		const registry = new SlashCommandRegistry();
		const snapshots: string[][] = [];
		const unsubscribe = registry.subscribe((commands) => snapshots.push(commands.map(({ name }) => name)));
		const close = registry.register({ name: "hello", description: "Hello", run: () => undefined });
		expect(registry.list().map(({ name }) => name)).toEqual(["hello"]);
		expect(() => registry.register({ name: "hello", run: () => undefined })).toThrow("already registered");
		close();
		close();
		expect(registry.list()).toEqual([]);
		expect(snapshots).toEqual([[], ["hello"], []]);
		unsubscribe();
	});

	test("stages replacements until the previous registration retires", () => {
		const registry = new SlashCommandRegistry();
		const first = { name: "hello", description: "First", run: () => undefined };
		const second = { name: "hello", description: "Second", run: () => undefined };
		const closeFirst = registry.register(first);
		const closeSecond = registry.replace(second);
		expect(registry.list()).toEqual([first]);

		closeSecond();
		expect(registry.list()).toEqual([first]);
		const closeReplacement = registry.replace(second);
		closeFirst();
		expect(registry.list()).toEqual([second]);
		closeReplacement();
		expect(registry.list()).toEqual([]);
	});

	test("tracks plugin facet reload and unload", async () => {
		const registry = new SlashCommandRegistry();
		const originalRun = vi.fn();
		const host = await createFacetHost({
			facets: [
				createSlashCommandsRuntimeFacet(registry),
				defineFacet({
					id: "@test/example-hello",
					setup(env) {
						const commands = env.use(SlashCommands);
						env.onActivate(() =>
							env.own(commands.replace({ name: "hello", description: "Original", run: originalRun })),
						);
					},
				}),
			],
		});
		expect(registry.list().map(({ name }) => name)).toEqual(["hello"]);

		const failure = new Error("replacement failed");
		await expect(
			host.reload([
				defineFacet({
					id: "@test/example-hello",
					setup(env) {
						const commands = env.use(SlashCommands);
						env.onActivate(() => {
							env.own(commands.replace({ name: "hello", description: "Failing", run: () => undefined }));
							throw failure;
						});
					},
				}),
			]),
		).rejects.toBe(failure);
		expect(registry.list()).toEqual([expect.objectContaining({ name: "hello", run: originalRun })]);

		const replacementRun = vi.fn();
		await host.reload([
			defineFacet({
				id: "@test/example-hello",
				setup(env) {
					const commands = env.use(SlashCommands);
					env.onActivate(() =>
						env.own(commands.replace({ name: "hello", description: "Replacement", run: replacementRun })),
					);
				},
			}),
		]);
		expect(registry.list()).toEqual([
			expect.objectContaining({ name: "hello", description: "Replacement", run: replacementRun }),
		]);

		await host.dispose();
		expect(registry.list()).toEqual([]);
	});
});
