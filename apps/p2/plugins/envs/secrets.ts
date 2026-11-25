// Sandbox secrets (`<data>/sandbox-secrets.json`, 0600, owner-only): per sandbox, values its HTTP proxy injects into
// outbound request headers for their hosts (Gondolin's `createHttpHooks` secrets). The VM only sees placeholders. The
// file is read where a sandbox is started (the launcher's `start`, values on stdin); the owner API lists names, hosts
// and age, never values.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LockedFile, optionalText } from "@p2/app/v1/node";
import { SECRET_NAME, SECRET_PRESETS } from "./secret-presets.ts";

/** A host pattern a secret may go to (as allowed hosts: `*` wildcards). */
const HOST_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9.*-]*$/;

/** One stored secret. */
type StoredSecret = {
	hosts: string[];
	preset?: string;
	value: string;
	/** Changes with every save: the sandbox's configuration revision follows it. */
	version: string;
	setAt: number;
};
type SecretsFile = Record<string, Record<string, StoredSecret>>;

/** A secret as the owner sees it: everything but its value. */
export type SecretInfo = { name: string; hosts: string[]; preset?: string; setAt: number };

/** A secret as the sandbox's configuration names it (no value): what the launcher needs besides the value. */
export type SecretMeta = { name: string; hosts: string[]; version: string; aliases?: string[]; gitHosts?: string[] };

export function secretsPath(directory: string): string {
	return join(directory, "sandbox-secrets.json");
}

async function readSecrets(directory: string): Promise<SecretsFile> {
	const text = await optionalText(secretsPath(directory));
	if (!text?.trim()) return {};
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox-secrets.json");
	return value as SecretsFile;
}

/** The secrets of sandbox `sandbox`, without values. */
export async function listSecrets(directory: string, sandbox: string): Promise<SecretInfo[]> {
	const secrets = (await readSecrets(directory))[sandbox] ?? {};
	return Object.entries(secrets)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, secret]) => ({
			name,
			hosts: secret.hosts,
			...(secret.preset ? { preset: secret.preset } : {}),
			setAt: secret.setAt,
		}));
}

/** The configuration part (no values) and the values of sandbox `sandbox`'s secrets, for its launcher. */
export async function sandboxSecrets(
	directory: string,
	sandbox: string,
): Promise<{ meta: SecretMeta[]; values: Record<string, string> }> {
	const secrets = (await readSecrets(directory))[sandbox] ?? {};
	const meta: SecretMeta[] = [];
	const values: Record<string, string> = {};
	for (const [name, secret] of Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))) {
		const preset = SECRET_PRESETS.find((candidate) => candidate.id === secret.preset);
		meta.push({
			name,
			hosts: secret.hosts,
			version: secret.version,
			...(preset?.aliases ? { aliases: [...preset.aliases] } : {}),
			...(preset?.gitHosts ? { gitHosts: [...preset.gitHosts] } : {}),
		});
		values[name] = secret.value;
	}
	return { meta, values };
}

/** Every secret value of every sandbox (the log redactor's list). */
export async function allSecretValues(directory: string): Promise<string[]> {
	return Object.values(await readSecrets(directory)).flatMap((secrets) =>
		Object.values(secrets).map((secret) => secret.value),
	);
}

/**
 * Set (add or replace) secret `name` of `sandbox`. Without `value` an existing secret keeps its value and gets the new
 * hosts. Every host must be one of the sandbox's allowed hosts (`allowHosts`): the proxy only sends to those.
 */
export async function saveSecret(
	directory: string,
	sandbox: string,
	name: string,
	change: { value?: string; hosts: string[]; preset?: string },
	allowHosts: readonly string[],
): Promise<void> {
	if (!SECRET_NAME.test(name)) throw new Error("Secret names are environment variables: A-Z, 0-9 and _");
	if (change.hosts.length === 0) throw new Error("A secret needs at least one host");
	for (const host of change.hosts) {
		if (!HOST_PATTERN.test(host)) throw new Error(`Invalid host: ${host}`);
		if (!allowHosts.includes(host)) throw new Error(`${host} is not an allowed host of sandbox ${sandbox}`);
	}
	if (change.value !== undefined && (change.value.length === 0 || change.value.length > 16_384))
		throw new Error("A secret's value must have 1 to 16384 characters");
	if (change.value !== undefined && /[\r\n]/.test(change.value)) throw new Error("A secret's value is one line");
	await update(directory, (secrets) => {
		const own = secrets[sandbox] ?? {};
		secrets[sandbox] = own;
		const current = own[name];
		const value = change.value ?? current?.value;
		if (value === undefined) throw new Error(`Secret ${name} needs a value`);
		own[name] = {
			hosts: [...change.hosts],
			...(change.preset ? { preset: change.preset } : current?.preset ? { preset: current.preset } : {}),
			value,
			version: randomBytes(6).toString("hex"),
			setAt: change.value === undefined && current ? current.setAt : Date.now(),
		};
	});
}

/** Remove secret `name` of `sandbox` (every secret of it without `name`: the sandbox was deleted). */
export async function deleteSecret(directory: string, sandbox: string, name?: string): Promise<void> {
	await update(directory, (secrets) => {
		if (name === undefined) delete secrets[sandbox];
		else if (secrets[sandbox]) {
			delete secrets[sandbox][name];
			if (Object.keys(secrets[sandbox]).length === 0) delete secrets[sandbox];
		}
	});
}

async function update(directory: string, change: (secrets: SecretsFile) => void): Promise<void> {
	const file = new LockedFile(secretsPath(directory));
	try {
		await file.withLockAsync(async (current) => {
			const value: unknown = current?.trim() ? JSON.parse(current) : {};
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Invalid sandbox-secrets.json");
			const secrets = value as SecretsFile;
			change(secrets);
			return { result: undefined, next: `${JSON.stringify(secrets, null, 2)}\n` };
		});
	} finally {
		await file.close();
	}
}
