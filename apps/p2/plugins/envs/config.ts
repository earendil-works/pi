import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { envRevision, LockedFile, optionalText, stripBom, stripJsonComments } from "@p2/app/v1/node";
import { ENV_NAME, type EnvConfig, EnvConfigSchema, type EnvsConfig } from "./schema.ts";

export { envRevision } from "@p2/app/v1/node";
export { ENV_NAME, type EnvConfig, EnvConfigSchema, type EnvsConfig } from "./schema.ts";

const validator = compile(EnvConfigSchema);

function hasControl(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

/** No leading `-` (it would be read as an `ssh` option) and no whitespace or control characters. */
function sshField(value: string | undefined): boolean {
	return value === undefined || (!value.startsWith("-") && !/\s/.test(value) && !hasControl(value));
}

export function validateEnv(value: unknown): EnvConfig {
	if (!validator.check(value)) throw new Error("Invalid environment configuration");
	const config = structuredClone(value) as EnvConfig;
	if (!sshField(config.host) || !sshField(config.user)) throw new Error("Invalid host or user");
	if (hasControl(config.identityFile ?? "") || config.identityFile?.includes('"'))
		throw new Error("Invalid identity file");
	return config;
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
			if (value === undefined) delete envs[name];
			else envs[name] = value;
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
