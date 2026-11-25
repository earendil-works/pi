import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { envRevision, LockedFile, optionalText, stripBom, stripJsonComments } from "@p2/app/v1/node";
import { ENV_NAME, type EnvConfig, EnvConfigSchema, type EnvsConfig, type GondolinEnvConfig } from "./schema.ts";

export { envRevision } from "@p2/app/v1/node";
export {
	DEFAULT_DISK_GB,
	ENV_NAME,
	type EnvConfig,
	EnvConfigSchema,
	type EnvsConfig,
	type GondolinEnvConfig,
	isSandbox,
	type SandboxMount,
	type SshEnvConfig,
} from "./schema.ts";

const validator = compile(EnvConfigSchema);

function hasControl(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

/** No leading `-` (it would be read as an `ssh` option) and no whitespace or control characters. */
function sshField(value: string | undefined): boolean {
	return value === undefined || (!value.startsWith("-") && !/\s/.test(value) && !hasControl(value));
}

/** Paths p2 uses in a sandbox: where pi-env's daemon is copied, where Gondolin mounts the folders before binding. */
const RESERVED = ["/opt/pi-env", "/.p2-vfs"];

/** A path inside a sandbox: absolute, normalized, not the root, without control characters. */
function guestPath(path: string): boolean {
	return (
		path.startsWith("/") &&
		path !== "/" &&
		!hasControl(path) &&
		path
			.split("/")
			.slice(1)
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

/** One configuration on its own (a sandbox's host is checked against the others by `parseEnvs`). */
export function validateEnv(value: unknown): EnvConfig {
	if (!validator.check(value)) throw new Error("Invalid environment configuration");
	const config = structuredClone(value) as EnvConfig;
	if (config.type === "gondolin") {
		if (!ENV_NAME.test(config.host)) throw new Error("Invalid host environment");
		if (config.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(config.image))
			throw new Error("Invalid image");
		const guests = new Set<string>();
		for (const mount of config.mounts ?? []) {
			const host = mount.host === "~" || mount.host.startsWith("~/") || mount.host.startsWith("/");
			if (!host || hasControl(mount.host)) throw new Error(`Invalid folder: ${mount.host}`);
			if (!guestPath(mount.guest)) throw new Error(`Invalid path in the sandbox: ${mount.guest}`);
			if (
				RESERVED.some(
					(reserved) =>
						mount.guest === reserved ||
						reserved.startsWith(`${mount.guest}/`) ||
						mount.guest.startsWith(`${reserved}/`),
				)
			)
				throw new Error(`${mount.guest} is used by p2 in the sandbox (${RESERVED.join(", ")})`);
			// The launcher refuses these too, after resolving the path on the host; this is the form's early answer.
			if (!mount.readonly && (mount.host === "~" || mount.host === "/" || /^~\/\.pi(\/|$)/.test(mount.host)))
				throw new Error(`A writable folder must not contain or be inside ~/.pi: ${mount.host}`);
			if (guests.has(mount.guest)) throw new Error(`Two folders at ${mount.guest}`);
			guests.add(mount.guest);
		}
		for (const pattern of config.allowHosts ?? [])
			if (!/^[A-Za-z0-9*][A-Za-z0-9.*-]*$/.test(pattern)) throw new Error(`Invalid allowed host: ${pattern}`);
		return config;
	}
	if (!sshField(config.host) || !sshField(config.user)) throw new Error("Invalid host or user");
	if (hasControl(config.identityFile ?? "") || config.identityFile?.includes('"'))
		throw new Error("Invalid identity file");
	return config;
}

/** Every sandbox runs on a configured SSH environment. */
function checkHosts(envs: EnvsConfig): void {
	for (const [name, config] of Object.entries(envs))
		if (config.type === "gondolin" && envs[config.host]?.type !== "ssh")
			throw new Error(`Sandbox ${name} runs on "${config.host}", which is not an SSH environment`);
}

/** The sandboxes running on SSH environment `host`. */
export function sandboxesOn(envs: EnvsConfig, host: string): [string, GondolinEnvConfig][] {
	return Object.entries(envs).flatMap(([name, config]): [string, GondolinEnvConfig][] =>
		config.type === "gondolin" && config.host === host ? [[name, config]] : [],
	);
}

export function parseEnvs(content: string): EnvsConfig {
	let value: unknown;
	try {
		value = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		throw new Error("Invalid envs.json syntax");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid envs.json configuration");
	const envs: EnvsConfig = {};
	for (const [name, config] of Object.entries(value)) {
		if (!ENV_NAME.test(name)) throw new Error(`Invalid environment name: ${name}`);
		envs[name] = validateEnv(config);
	}
	checkHosts(envs);
	return envs;
}

export function envsPath(directory: string): string {
	return join(directory, "envs.json");
}

export async function loadEnvs(directory: string): Promise<EnvsConfig> {
	return parseEnvs((await optionalText(envsPath(directory))) ?? "{}");
}

/** Add, replace (`config`) or remove (`undefined`) one environment, under the file's lock. */
export async function saveEnv(directory: string, name: string, config: EnvConfig | undefined): Promise<void> {
	if (!ENV_NAME.test(name)) throw new Error("Names use lowercase letters, digits, - and _ (at most 32)");
	const value = config === undefined ? undefined : validateEnv(config);
	const file = new LockedFile(envsPath(directory));
	try {
		await file.withLockAsync(async (current) => {
			const envs = current === undefined ? {} : parseEnvs(current);
			if (value === undefined) {
				const on = sandboxesOn(envs, name).map(([sandbox]) => sandbox);
				if (on.length) throw new Error(`Sandboxes run on "${name}": ${on.join(", ")}`);
				delete envs[name];
			} else envs[name] = value;
			checkHosts(envs);
			return { result: undefined, next: `${JSON.stringify(envs, null, 2)}\n` };
		});
	} finally {
		await file.close();
	}
}

/** The env's `FileSystem.id`: equal ids see the same files. */
export function envId(name: string, config: EnvConfig): string {
	return `pi-env:${name}@${envRevision(config)}`;
}

/** Host keys this application trusts, separate from the user's own `known_hosts`. */
export function knownHostsPath(directory: string): string {
	return join(directory, "ssh", "known_hosts");
}

/** The name an env's host keys are stored under, independent of host aliases, ports and jump hosts. */
export function hostKeyAlias(name: string): string {
	return `pi-env-${name}`;
}
