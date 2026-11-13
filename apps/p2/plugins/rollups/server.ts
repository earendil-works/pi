// Rollups made from code (server): the saved rollups and their last results in the server's store, running their
// scripts in a code mode sandbox without tools, refreshing them by their `refresh` (`auto`: when what a script read
// changed; `every`: on its interval, when that changed; by hand always), and serving them to the owner's sidebar and to
// the Familiar's tool.
import { randomUUID } from "node:crypto";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { obj } from "@earendil-works/pi-schema";
import {
	type Ctx,
	defineFacet,
	defineState,
	deriveTyped,
	forbidden,
	isOwner,
	isWorker,
	record,
	sleep,
} from "@p2/app/v1";
import { Hosts } from "@p2/app/v1/server";
import { FamiliarStore } from "../familiar/contract.ts";
import { ProjectService } from "../projects/contract.ts";
import { SearchIndex } from "../search/contract.ts";
import { Catalog } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { type RollupDefinition, type RollupEntry, RollupEntrySchema, RollupStore, SidebarRollups } from "./contract.ts";
import {
	fingerprintOf,
	inputOf,
	isMentionCall,
	MENTIONS_GLOBAL,
	mentionOf,
	mentionRead,
	type RollupFacts,
	type RollupInput,
	RUN_MEMORY_BYTES,
	runRollup,
} from "./runner.ts";

/** The saved rollups by key, with their last results. */
const Saved = defineState("p2.rollups", {
	schema: obj({ rollups: record(RollupEntrySchema) }),
	version: 1,
	initial: () => ({ rollups: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

/** How often the interval refreshes look for a rollup that is due. */
const TICK_MS = 30_000;

export default defineFacet((host) => {
	host.serve(RollupStore, (_params, self) => {
		const saved = self.state(Saved);
		const catalog = self.get(Catalog, {});
		const statuses = self.get(StatusStore, {});
		const search = self.get(SearchIndex, {});
		const projects = self.get(ProjectService, {});
		const familiar = self.get(FamiliarStore, {});
		// The runs in progress by token: the context their scripts' `mentions` calls run in, and what those answered.
		const runs = new Map<string, { ctx: Ctx; mentions: Map<string, Readonly<Record<string, number>>> }>();
		const mentions: CodemodeTool = {
			name: MENTIONS_GLOBAL,
			execute: async (args) => {
				// What the script passed: checked here.
				if (!isMentionCall(args))
					throw new Error("mentions(query, { since }) takes a query of 1 to 500 characters");
				const run = runs.get(args.run);
				if (!run) throw new Error("mentions() works only while its rollup runs");
				const mention = { query: args.query, ...(args.since === undefined ? {} : { since: args.since }) };
				const found = await search.mentions(mention, run.ctx);
				run.mentions.set(mentionRead(mention), found);
				return found;
			},
		};
		const sandbox = self.open(
			async () => new CodemodeSandbox({ memoryLimitBytes: RUN_MEMORY_BYTES, globals: [mentions] }),
			(opened) => opened.close(),
		);
		const facts = deriveTyped(
			self,
			[
				catalog.sessions,
				statuses.statuses,
				search.answers,
				search.reads,
				projects.projects,
				projects.sessions,
				familiar.session,
			],
			([sessions, statuses, answers, reads, projects, memberships, familiar]): RollupFacts => ({
				sessions,
				statuses,
				answers,
				reads,
				projects,
				memberships,
				familiar,
			}),
		);

		/** Runs `code` against `input` in `ctx`: its result, and what its `mentions` calls answered by read path. */
		const run = async (code: string, input: RollupInput, ctx: Ctx) => {
			const token = randomUUID();
			const answered = new Map<string, Readonly<Record<string, number>>>();
			runs.set(token, { ctx, mentions: answered });
			try {
				return { result: await runRollup(sandbox.value, code, input, token), answered };
			} finally {
				runs.delete(token);
			}
		};

		/** What each `mentions` call among `reads` answers now, by read path. */
		const mentionsNow = async (reads: readonly string[], ctx: Ctx) => {
			const answers = new Map<string, Readonly<Record<string, number>>>();
			for (const path of reads) {
				const mention = mentionOf(path);
				if (mention) answers.set(path, await search.mentions(mention, ctx));
			}
			return answers;
		};

		/** The entry of `key`, or a refusal naming it. */
		const entryOf = (key: string): RollupEntry => {
			const entry = saved.value.rollups[key];
			if (!entry) throw new Error(`No rollup "${key}"`);
			return entry;
		};

		// One update per rollup at a time: a save's run and the automatic check it wakes would otherwise both run it.
		const queues = new Map<string, Promise<unknown>>();
		const update = (key: string, mode: UpdateMode, ctx: Ctx): Promise<RollupEntry> => {
			// The update before reported its failure to its own caller; this one runs regardless.
			const queued = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => updateNow(key, mode, ctx));
			queues.set(key, queued);
			return queued;
		};

		/**
		 * Brings `key` up to date: runs its script, unless `mode` skips a rollup whose last run read values that are
		 * unchanged (`check` then notes when it was checked). A failed run keeps the last good output.
		 */
		const updateNow = async (key: string, mode: UpdateMode, ctx: Ctx): Promise<RollupEntry> => {
			const entry = entryOf(key);
			const now = Date.now();
			const input = inputOf(facts.value, now);
			if (
				mode !== "force" &&
				entry.fingerprint !== null &&
				entry.fingerprint === fingerprintOf(input, entry.reads, await mentionsNow(entry.reads, ctx))
			) {
				if (mode === "check")
					await saved.change((draft) => {
						const current = draft.rollups[key];
						if (current) current.checkedAt = now;
					}, ctx);
				return entryOf(key);
			}
			const { result, answered } = await run(entry.definition.code, input, ctx);
			await saved.change((draft) => {
				const current = draft.rollups[key];
				// Removed or replaced while it ran: the result belongs to a script that is no longer saved.
				if (!current || current.definition.code !== entry.definition.code) return;
				current.checkedAt = now;
				// A failed run's reads are unknown: it counts as having read everything, so it runs again once anything
				// changed, not on every wake.
				const reads = result.ok ? result.reads : EVERYTHING;
				current.reads = reads;
				current.fingerprint = fingerprintOf(input, reads, answered);
				if (result.ok) {
					current.output = result.output;
					current.error = null;
				} else current.error = result.error;
			}, ctx);
			return entryOf(key);
		};

		// `auto`: whenever the facts change, each automatic rollup whose reads changed runs again. Only the facts wake it,
		// never the rollups' own results: a script that reads `now()` changes its fingerprint on every run, and woken by its
		// own write it would run in a loop. A saved rollup runs in `save`.
		self.on(facts, async (_change, ctx) => {
			for (const [key, entry] of Object.entries(saved.value.rollups))
				if (entry.definition.refresh.kind === "auto") await update(key, "skip", ctx);
		});

		// On each tick: an `every` rollup whose interval passed since it was last checked is checked (it runs if its reads
		// changed), and an `auto` one that reads `now()` runs, so its time moves on without a change of the facts.
		self.onLive(async (ctx) => {
			for (;;) {
				const now = Date.now();
				for (const [key, entry] of Object.entries(saved.value.rollups)) {
					const { refresh } = entry.definition;
					if (refresh.kind === "every" && now - (entry.checkedAt ?? 0) >= refresh.minutes * 60_000)
						await update(key, "check", ctx);
					else if (refresh.kind === "auto" && entry.reads.includes("now")) await update(key, "skip", ctx);
				}
				await sleep(TICK_MS, ctx);
			}
		});

		return {
			rollups: deriveTyped(self, [saved], ([state]) => Object.values(state.rollups)),
			save: async (definition, ctx) => {
				await saved.change((draft) => {
					draft.rollups[definition.key] = fresh(definition);
				}, ctx);
				return update(definition.key, "force", ctx);
			},
			remove: async ({ key }, ctx) => {
				entryOf(key);
				await saved.change((draft) => {
					delete draft.rollups[key];
				}, ctx);
				return null;
			},
			refresh: ({ key }, ctx) => update(key, "force", ctx),
			preview: async ({ code }, ctx) => (await run(code, inputOf(facts.value, Date.now()), ctx)).result,
		};
	});

	host.serve(SidebarRollups, (_params, principal, self) => {
		const store = self.get(RollupStore, {});
		if (isOwner(principal))
			return {
				variant: "owner",
				members: {
					rollups: store.rollups,
					save: (definition, ctx) => store.save(definition, ctx),
					remove: (args, ctx) => store.remove(args, ctx),
					refresh: (args, ctx) => store.refresh(args, ctx),
					preview: (args, ctx) => store.preview(args, ctx),
				},
			};
		if (!isWorker(principal)) throw forbidden("rollups are the owner's and the Familiar's");
		const familiar = self.get(FamiliarStore, {});
		const hosts = self.get(Hosts, {});
		/** Admits a call of the Familiar's current worker only. */
		const admit = () => {
			const current = hosts.workers.value[principal.session];
			if (!current?.running || current.generation !== principal.generation) throw forbidden("stale worker");
			if (familiar.session.value !== principal.session) throw forbidden("only the Familiar manages rollups");
		};
		return {
			variant: "familiar",
			members: {
				list: async () => {
					admit();
					return store.rollups.value;
				},
				save: async (definition, ctx) => {
					admit();
					return store.save(definition, ctx);
				},
				remove: async (args, ctx) => {
					admit();
					return store.remove(args, ctx);
				},
				refresh: async (args, ctx) => {
					admit();
					return store.refresh(args, ctx);
				},
				preview: async (args, ctx) => {
					admit();
					return store.preview(args, ctx);
				},
			},
		};
	});
});

/** What a failed run counts as having read. */
const EVERYTHING = ["sessions.*", "projects"];

/** What `update` does when a rollup's reads are unchanged: run anyway, skip quietly, or skip and note the check. */
type UpdateMode = "force" | "skip" | "check";

/** A rollup as saved before its first run. */
function fresh(definition: RollupDefinition): RollupEntry {
	return { definition, output: null, checkedAt: null, error: null, reads: [], fingerprint: null };
}
