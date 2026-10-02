import fs from "node:fs";
import * as logger from "./logger.ts";
import { materializeProfile, profileDirFor, removeProfileDir } from "./materializer.ts";
import {
	addProfile,
	applySetOption,
	applyUnsetOption,
	clearDefaultProfile,
	formatModels,
	getDefaultProfileName,
	loadProfiles,
	maskToken,
	mergeModelsUpdate,
	removeProfile,
	renameProfile,
	setDefaultProfile,
	updateProfile,
	validateThinking,
} from "./profiles.ts";
import type { Profile } from "./types.ts";
import { PI_PROVIDERS } from "./types.ts";

/** Top-level subcommands owned by the hub package. */
export const HUB_SUBCOMMANDS: ReadonlySet<string> = new Set(["profile", "use", "unuse"]);

/**
 * Caller-injected capabilities for `dispatchHubCommand`. Hub stays
 * dependency-free and cannot run a provider login itself (that needs the pi
 * model runtime), so the CLI wraps it and passes the hook here.
 */
export interface HubCommandOptions {
	/**
	 * Runs the interactive provider login for a freshly created profile,
	 * persisting the credential into the profile's materialized agent dir.
	 * Invoked by `profile add` when the profile only selects a provider.
	 * Rejects when the login fails or is cancelled.
	 */
	login?: (context: { profileDir: string; provider: string }) => Promise<void>;
}

interface SubcommandArgv {
	/** Canonical option name -> collected values (repeatable options collect multiple). */
	values: Map<string, string[]>;
	/** Canonical flag names that were present. */
	flags: Set<string>;
	positionals: string[];
}

const VALUE_OPTIONS = new Map<string, string>([
	["-m", "model"],
	["--model", "model"],
	["-t", "token"],
	["--token", "token"],
	["-u", "url"],
	["--url", "url"],
	["-p", "provider"],
	["--provider", "provider"],
	["--thinking", "thinking"],
	["--set", "set"],
	["--unset", "unset"],
	["-d", "deleteModel"],
	["--delete-model", "deleteModel"],
]);

const FLAG_OPTIONS = new Map<string, string>([
	["-j", "json"],
	["--json", "json"],
]);

/** Hand-rolled option parser for hub subcommands (pi style, no arg-parsing lib). */
function parseSubcommandArgv(argv: string[]): SubcommandArgv {
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	const positionals: string[] = [];
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		const eq = arg.indexOf("=");
		const name = eq !== -1 ? arg.slice(0, eq) : arg;
		const inlineValue = eq !== -1 ? arg.slice(eq + 1) : undefined;
		const valueName = VALUE_OPTIONS.get(name);
		if (valueName) {
			let value = inlineValue;
			if (value === undefined) {
				value = argv[i + 1];
				i++;
			}
			if (value === undefined) {
				throw new Error(`Error: ${name} expects a value.`);
			}
			const list = values.get(valueName) || [];
			list.push(value);
			values.set(valueName, list);
		} else if (FLAG_OPTIONS.has(name)) {
			flags.add(FLAG_OPTIONS.get(name) as string);
		} else if (name.startsWith("-") && name !== "-") {
			throw new Error(`Error: unknown option '${name}'.`);
		} else {
			positionals.push(arg);
		}
		i++;
	}
	return { values, flags, positionals };
}

function getValues(parsed: SubcommandArgv, name: string): string[] | undefined {
	const list = parsed.values.get(name);
	return list && list.length > 0 ? list : undefined;
}

function warnUnknownProvider(provider?: string): void {
	if (provider && !PI_PROVIDERS.includes(provider)) {
		console.error(`Warning: '${provider}' is not a known pi provider id. Continuing anyway.`);
	}
}

function warnMissingProvider(p: Profile): void {
	if ((p.token || p.url) && !p.provider) {
		console.error(
			"Warning: no provider set (-p). At run time the token/url will be keyed under " +
				"your default pi provider (or the provider/model id prefix), which may not be what you intend.",
		);
	}
}

function applyProfileOptions(p: Profile, parsed: SubcommandArgv): void {
	const token = getValues(parsed, "token")?.[0];
	const url = getValues(parsed, "url")?.[0];
	const provider = getValues(parsed, "provider")?.[0];
	const thinking = getValues(parsed, "thinking")?.[0];
	if (token) p.token = token;
	if (url) p.url = url;
	if (provider) {
		warnUnknownProvider(provider);
		p.provider = provider;
	}
	if (thinking) {
		validateThinking(thinking);
		p.thinking = thinking;
	}
	for (const kv of getValues(parsed, "set") || []) {
		applySetOption(p, kv);
	}
	for (const key of getValues(parsed, "unset") || []) {
		applyUnsetOption(p, key);
	}
}

function cmdProfileAdd(parsed: SubcommandArgv, options: HubCommandOptions): void | Promise<void> {
	const name = parsed.positionals[0];
	if (!name) {
		throw new Error("Error: profile name is required. Usage: pipi profile add <name> [options]");
	}
	const models = getValues(parsed, "model");
	if (models && models.length > 3) {
		throw new Error("Error: A profile can have at most 3 models.");
	}
	validateThinking(getValues(parsed, "thinking")?.[0]);
	warnUnknownProvider(getValues(parsed, "provider")?.[0]);

	const profile: Profile = {};
	if (models) {
		profile.models = models;
		profile.model = models[0];
	}
	applyProfileOptions(profile, parsed);
	warnMissingProvider(profile);

	// Materialize right away so the profile dir exists and tracks the source
	// settings from the moment the profile is created.
	let profileDir: string | undefined;
	try {
		profileDir = materializeProfile(name, profile);
	} catch (err) {
		logger.debug(`profile add: initial materialize failed: ${err}`);
	}

	addProfile(name, profile);
	console.log(`Profile '${name}' saved.`);

	// A profile that only selects a provider carries no credential: treat the
	// add as "log this profile into that provider" and run the provider's
	// interactive login (OAuth login page / API-key setup), persisting the
	// credential into the profile's agent dir. Without an injected login the
	// provider-only profile is stored as before.
	const provider = profile.provider;
	const providerOnly = provider !== undefined && Object.keys(profile).length === 1;
	if (providerOnly && options.login && profileDir) {
		console.log(`No token given — invoking the '${provider}' login for profile '${name}'...`);
		return runProviderLogin(name, provider, profileDir, options.login);
	}
}

/** Awaiting half of `profile add`: a failed or cancelled login never un-saves
 *  the profile — the caller reports it and suggests adding a token later. */
function runProviderLogin(
	name: string,
	provider: string,
	profileDir: string,
	login: NonNullable<HubCommandOptions["login"]>,
): Promise<void> {
	return login({ profileDir, provider }).then(
		() => {
			console.log(`Logged in to '${provider}'.`);
		},
		(err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Login did not complete: ${message}`);
			console.error(`Profile '${name}' kept without credentials — 'pipi profile update ${name} -t <key>'.`);
		},
	);
}

function cmdProfileUpdate(parsed: SubcommandArgv): void {
	const name = parsed.positionals[0];
	if (!name) {
		throw new Error("Error: profile name is required. Usage: pipi profile update <name> [options]");
	}
	const data = loadProfiles();
	const p = data.profiles[name];
	if (!p) {
		throw new Error(`Profile '${name}' not found. Use 'profile add' to create it.`);
	}

	const providedModels = getValues(parsed, "model");
	const modelsToDelete = getValues(parsed, "deleteModel");

	if (modelsToDelete) {
		const toRemove = new Set(modelsToDelete);
		const currentModels = p.models || (p.model ? [p.model] : []);
		const newModels = currentModels.filter((m) => !toRemove.has(m));
		const removedCount = currentModels.length - newModels.length;

		if (removedCount === 0) {
			console.log(`No matching models to remove from profile '${name}'.`);
		} else if (newModels.length === 0) {
			delete p.models;
			delete p.model;
			console.log(`Removed all models from profile '${name}'.`);
		} else {
			p.models = newModels;
			p.model = newModels[0];
			console.log(`Removed ${removedCount} model(s) from profile '${name}'.`);
		}
	}

	if (providedModels) {
		const currentModels = p.models || (p.model ? [p.model] : []);
		const merged = mergeModelsUpdate(currentModels, providedModels);
		p.models = merged.models;
		p.model = merged.models[0];
		for (const message of merged.messages) {
			console.log(message);
		}
	}

	const finalModels = p.models || (p.model ? [p.model] : []);
	if (finalModels.length > 3) {
		throw new Error("Error: A profile can have at most 3 models.");
	}

	applyProfileOptions(p, parsed);
	warnMissingProvider(p);
	updateProfile(name, p);
	console.log(`Profile '${name}' updated.`);
}

function cmdProfileList(): void {
	const data = loadProfiles();
	const profiles = data.profiles;
	const names = Object.keys(profiles);
	if (names.length === 0) {
		console.log("No profiles defined. Use 'profile add' to create one.");
		return;
	}
	const def = data.default || "";
	const fmt = (
		marker: string,
		name: string,
		model: string,
		provider: string,
		thinking: string,
		token: string,
		url: string,
	) =>
		`${marker.padEnd(2)}  ${name.padEnd(20)}  ${model.padEnd(30)}  ${provider.padEnd(22)}  ${thinking.padEnd(10)}  ${token.padEnd(20)}  ${url}`;

	console.log(fmt("", "NAME", "MODEL(S)", "PROVIDER", "THINKING", "TOKEN", "URL"));
	console.log(fmt("", "----", "--------", "--------", "---------", "-----", "---"));
	for (const name of names) {
		const p = profiles[name];
		const marker = name === def ? "* " : "  ";
		console.log(
			fmt(
				marker,
				name,
				formatModels(p),
				p.provider || "(default)",
				p.thinking || "(default)",
				maskToken(p.token || ""),
				p.url || "(default)",
			),
		);
	}
}

function cmdProfileView(parsed: SubcommandArgv): void {
	const name = parsed.positionals[0];
	if (!name) {
		throw new Error("Error: profile name is required. Usage: pipi profile view <name> [-j]");
	}
	const p = loadProfiles().profiles[name];
	if (!p) {
		throw new Error(`Profile '${name}' not found.`);
	}
	if (parsed.flags.has("json")) {
		console.log(JSON.stringify({ name, ...p }, null, 2));
		return;
	}
	console.log(`Name:     ${name}`);
	console.log(`Provider: ${p.provider || "(default)"}`);
	console.log(`Model:    ${p.model || "(unset)"}`);
	if (p.models && p.models.length > 0) {
		console.log(`Models:`);
		for (const m of p.models) {
			console.log(`  - ${m}`);
		}
	}
	console.log(`Thinking: ${p.thinking || "(default)"}`);
	console.log(`Token:    ${p.token || "(unset)"}`);
	console.log(`URL:      ${p.url || "(default)"}`);
	if (p.settings && Object.keys(p.settings).length > 0) {
		console.log(`Settings overrides:`);
		for (const [key, value] of Object.entries(p.settings)) {
			console.log(`  ${key} = ${JSON.stringify(value)}`);
		}
	}
}

function cmdProfileRemove(parsed: SubcommandArgv): void {
	const name = parsed.positionals[0];
	if (!name) {
		throw new Error("Error: profile name is required. Usage: pipi profile remove <name>");
	}
	removeProfile(name);
	removeProfileDir(name);
	console.log(`Profile '${name}' removed.`);
}

function cmdProfileRename(parsed: SubcommandArgv): void {
	const oldName = parsed.positionals[0];
	const newName = parsed.positionals[1];
	if (!oldName || !newName) {
		throw new Error("Error: both names are required. Usage: pipi profile rename <old> <new>");
	}
	renameProfile(oldName, newName);

	const oldDir = profileDirFor(oldName);
	if (fs.existsSync(oldDir)) {
		removeProfileDir(newName);
		fs.renameSync(oldDir, profileDirFor(newName));
	}
	console.log(`Profile '${oldName}' renamed to '${newName}'.`);
}

function cmdProfileDefault(parsed: SubcommandArgv): void {
	const name = parsed.positionals[0];
	if (!name) {
		throw new Error("Profile name is required. Use 'pipi unuse' to run pi with your existing config.");
	}
	setDefaultProfile(name);
	console.log(`Default profile set to '${name}'.`);
}

function dispatchProfile(argv: string[], options: HubCommandOptions): void | Promise<void> {
	const sub = argv[0];
	const parsed = parseSubcommandArgv(argv.slice(1));
	switch (sub) {
		case "add":
			return cmdProfileAdd(parsed, options);
		case "update":
			cmdProfileUpdate(parsed);
			return;
		case "list":
			cmdProfileList();
			return;
		case "view":
			cmdProfileView(parsed);
			return;
		case "remove":
			cmdProfileRemove(parsed);
			return;
		case "rename":
			cmdProfileRename(parsed);
			return;
		case "default":
			cmdProfileDefault(parsed);
			return;
		case undefined:
			throw new Error(`Error: 'profile' requires a subcommand (${"add|update|list|view|remove|rename|default"}).`);
		default:
			throw new Error(`Error: unknown profile subcommand '${sub}'. Use: add|update|list|view|remove|rename|default`);
	}
}

function dispatchUse(argv: string[]): void {
	const parsed = parseSubcommandArgv(argv);
	const name = parsed.positionals[0];
	if (!name) {
		const current = getDefaultProfileName();
		console.log(current ? `Default profile: '${current}'.` : "No default profile set (running as plain pi).");
		return;
	}
	setDefaultProfile(name);
	console.log(`Default profile set to '${name}'.`);
}

function dispatchUnuse(): void {
	clearDefaultProfile();
	console.log("Default profile unset (running as plain pi).");
}

/**
 * Dispatch a hub subcommand (args[0] must be one of HUB_SUBCOMMANDS).
 * All hub subcommands are self-contained management commands.
 *
 * `options` injects capabilities hub cannot implement itself (provider
 * login — see `HubCommandOptions`).
 *
 * Throws synchronously on invalid usage or unknown profiles — callers are
 * expected to print the error and exit non-zero. Returns a promise only when
 * the command awaits an injected provider login (`profile add` with only a
 * provider); callers must await it before exiting.
 */
export function dispatchHubCommand(args: string[], options: HubCommandOptions = {}): void | Promise<void> {
	logger.info(`Executing: ${args.join(" ")}`);
	const command = args[0];
	const argv = args.slice(1);
	switch (command) {
		case "profile":
			return dispatchProfile(argv, options);
		case "use":
			dispatchUse(argv);
			return;
		case "unuse":
			dispatchUnuse();
			return;
		default:
			throw new Error(`Error: unknown hub command '${command}'.`);
	}
}
