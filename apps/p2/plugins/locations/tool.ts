// The location tools: an agent lists the environments it may work on and their directories, and moves itself. Every main
// agent has them, and the subagents and one-shot agents it gives them to. A session in a sandbox stays in it.

import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Context, DirectoryListing } from "@p2/app/v1";
import { type Location, locationText, parseLocation, sameLocation } from "@p2/app/v1";
import { defineP2Tool, isTopLevel, type P2Tool } from "@p2/app/v1/worker";
import { placeSubagent } from "../subagents/contract.worker.ts";
import type { EnvInfo } from "./contract.ts";
import { LocationMoveDoc } from "./contract.worker.ts";

/** How many folders a listing shows. */
const MAX_LISTED = 200;

export type LocationServer = {
	envs(context: Context): Promise<EnvInfo[]>;
	directories(env: string | null, path: string, context: Context): Promise<DirectoryListing>;
};
export type LocationTools = {
	readonly server: LocationServer;
	/** Where a conversation works now. */
	readonly locate: (id: ConversationId, read: DocumentReader, context: Context) => Promise<Location>;
};

/**
 * The sandbox a conversation working at `here` is confined to, decided by its environment's configured type: it may
 * move within the sandbox, never out of it (only the owner's Relocate leaves it).
 */
export const sandboxAt = (here: Location, envs: readonly EnvInfo[]): string | undefined =>
	here.env !== null && envs.some((env) => env.name === here.env && env.type === "gondolin") ? here.env : undefined;

const describeEnv = (env: EnvInfo, here: Location): string => {
	const target =
		env.type === "gondolin"
			? `sandbox (a VM on ${env.host})`
			: `ssh ${env.user ? `${env.user}@` : ""}${env.host}${env.port ? `:${env.port}` : ""}`;
	const tested =
		env.tested === undefined
			? "not tested"
			: env.tested.ok
				? `tested ok (${env.tested.platform} ${env.tested.arch})`
				: `last test failed: ${env.tested.error}`;
	return `- ${env.name}: ${target} · ${tested}${here.env === env.name ? " · you are here" : ""}`;
};

export function createLocationExtension({ server, locate }: LocationTools) {
	/** `[env:]path` (or `env` and `cwd`) from where the caller works, resolved by the server to an existing directory. */
	const target = async (
		args: { location?: string; env?: string | null; cwd?: string },
		here: Location,
		context: Context,
	): Promise<{ listing: DirectoryListing; env: string | null } | string> => {
		const envs = await server.envs(context);
		const names = envs.map((env) => env.name);
		const sandbox = sandboxAt(here, envs);
		const parsed =
			args.location !== undefined
				? parseLocation(args.location, names, here)
				: parseLocation(args.cwd ?? "", names, {
						env: args.env === undefined ? here.env : args.env,
						...(args.env === undefined || args.env === here.env ? { cwd: here.cwd } : {}),
					});
		if ("error" in parsed) return parsed.error;
		if (sandbox !== undefined && parsed.env !== sandbox)
			return `You work in sandbox ${sandbox} and cannot leave it; use paths inside ${sandbox}.`;
		if (parsed.env !== null && !names.includes(parsed.env))
			return `Unknown environment "${parsed.env}" (location_envs lists them).`;
		try {
			return { listing: await server.directories(parsed.env, parsed.path, context), env: parsed.env };
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			const where = `${parsed.env ? `${parsed.env}:` : ""}${parsed.path}`;
			return `${where}: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	const where = {
		location: opt(
			str({
				description:
					"[env:]path, e.g. gpu:~/project, local:/tmp (this device) or ../other (relative to your cwd); no prefix: your environment",
			}),
		),
		env: opt(
			union([str(), nul()], {
				description: "Instead of location: an environment, null for this device",
			}),
		),
		cwd: opt(str({ description: "Instead of location: a path on env (default your environment)" })),
	};
	return defineExtension<P2Tool>({
		name: "p2-locations",
		tools: [
			defineP2Tool({
				name: "location_envs",
				description:
					"List the environments you can work on: this device, the configured SSH environments (host, last test) and sandboxes. Shows where you work now.",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async (_args, api, context) => {
					const reply = (text: string, isError = false) => ({
						output: [{ type: "text" as const, text }],
						details: {},
						isError,
					});
					const here = await locate(api.conversationId, api, context);
					const envs = await server.envs(context);
					const sandbox = sandboxAt(here, envs);
					if (sandbox !== undefined)
						return reply(
							[
								`You work at ${locationText(here)}, in sandbox ${sandbox}: a VM whose tools reach only its own files and allowed hosts.`,
								"You cannot leave it; location_dirs and location_move take paths inside it.",
								...envs.filter((env) => env.name === sandbox).map((env) => describeEnv(env, here)),
							].join("\n"),
						);
					// The session's move is kept on conversation 1 whichever top-level conversation asked for it.
					const move = (await isTopLevel(api, api.conversationId, context))
						? await api.snapshot(LocationMoveDoc, ROOT_CONVERSATION_ID, context)
						: undefined;
					return reply(
						[
							`You work at ${locationText(here)}.`,
							...(move?.pending
								? [`Your session moves to ${locationText(move.pending)} when this turn ends.`]
								: []),
							...(move?.failed
								? [`The last move to ${locationText(move.failed.to)} failed: ${move.failed.error}`]
								: []),
							"Environments:",
							`- local: this device (where p2 runs)${here.env === null ? " · you are here" : ""}`,
							...envs.map((env) => describeEnv(env, here)),
						].join("\n"),
					);
				},
			}),
			defineP2Tool({
				name: "location_dirs",
				description:
					"List the folders of a directory on an environment (default: your cwd), to find where to work. Shows at most 200.",
				parameters: obj(where, { open: true }),
				replay: "safe",
				execute: async (args, api, context) => {
					const reply = (text: string, isError = false) => ({
						output: [{ type: "text" as const, text }],
						details: {},
						isError,
					});
					const here = await locate(api.conversationId, api, context);
					const found = await target(
						args.location === undefined && args.cwd === undefined && args.env === undefined
							? { location: here.cwd }
							: args,
						here,
						context,
					);
					if (typeof found === "string") return reply(found, true);
					const { listing, env } = found;
					const prefix = env ? `${env}:` : "";
					const names = listing.directories.slice(0, MAX_LISTED).map((path) => `${path.split(/[\\/]/).pop()}/`);
					const more = listing.directories.length - names.length;
					return reply(
						[
							`${prefix}${listing.path}${listing.parent ? ` (parent ${prefix}${listing.parent})` : ""}`,
							names.length ? names.join("\n") : "No folders.",
							...(more > 0 || listing.truncated
								? [`More folders are not shown${more > 0 ? ` (${more}+)` : ""}.`]
								: []),
						].join("\n"),
					);
				},
			}),
			defineP2Tool({
				name: "location_move",
				description: [
					"Move yourself to another directory or environment.",
					"The main agent moves its whole session there once this turn has ended (after your last answer, when no subagent",
					"work is running); subagents following the session move with it, subagents with their own location stay. Your",
					"tools keep running where you are until then.",
					"A subagent given this tool moves only itself, at once: its next tool calls run at the new location.",
				].join("\n"),
				parameters: obj(where, { open: true }),
				// Setting the same destination again changes nothing.
				replay: "safe",
				execute: async (args, api, context) => {
					const reply = (text: string, details: { env?: string | null; cwd?: string } = {}, isError = false) => ({
						output: [{ type: "text" as const, text }],
						details,
						isError,
					});
					if (args.location === undefined && args.cwd === undefined && args.env === undefined)
						return reply("location_move needs location, or env and cwd.", {}, true);
					const here = await locate(api.conversationId, api, context);
					const found = await target(args, here, context);
					if (typeof found === "string") return reply(found, {}, true);
					const to: Location = { env: found.env, cwd: found.listing.path };
					const details = { env: to.env, cwd: to.cwd };
					if (await isTopLevel(api, api.conversationId, context)) {
						const pending = (await api.snapshot(LocationMoveDoc, ROOT_CONVERSATION_ID, context))?.pending;
						if (sameLocation(to, here) && !pending)
							return reply(`You already work at ${locationText(to)}.`, details);
						await api.commit(async (tx) => {
							const state = await tx.doc(LocationMoveDoc, ROOT_CONVERSATION_ID);
							state.pending = to;
							delete state.failed;
						}, context);
						return reply(
							`The session moves to ${locationText(to)} when this turn ends (once no run or subagent work is active). Subagents following the session move with it; subagents with their own location stay where they are.`,
							details,
						);
					}
					if (sameLocation(to, here)) return reply(`You already work at ${locationText(to)}.`, details);
					const moved = await api.commit((tx) => placeSubagent(tx, api.conversationId, to), context);
					if (!moved) return reply("Only the main agent and subagents can move.", {}, true);
					return reply(`You work at ${locationText(to)} now; the session's moves no longer move you.`, details);
				},
			}),
		],
	});
}
