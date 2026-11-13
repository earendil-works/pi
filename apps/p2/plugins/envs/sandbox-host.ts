// p2's sandbox launcher on a host environment: deploying it (sandbox/ of this plugin, named by its content under the
// host's ~/.pi/p2/sandbox/; the files are read from the source directory the caller passes), the command line that runs it over SSH, and one-shot commands (check, start, status, stop)
// whose JSON answer p2 reads.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type RemotePlatform, type SshTarget, sshArguments } from "@earendil-works/pi-env";
import { DEFAULT_DISK_GB, type GondolinEnvConfig } from "./config.ts";
import type { SecretMeta } from "./secrets.ts";

/** The launcher's files as deployed: name on the host, file in the launcher's source directory. */
const FILES: readonly (readonly [string, string])[] = [
	["p2-sandbox.sh", "p2-sandbox.sh"],
	["p2-sandbox.mjs", "p2-sandbox.mjs"],
	["package.json", "host-package.json"],
	["package-lock.json", "host-package-lock.json"],
];

type Bundle = { readonly files: readonly (readonly [string, Buffer])[]; readonly id: string };
const bundles = new Map<string, Bundle>();

/**
 * The launcher's files from `source` (this plugin's sandbox/ directory: a facet passes `pluginFile("sandbox")`) and
 * the name of their directory on the host (their SHA-256), read once per source.
 */
function bundleOf(source: string): Bundle {
	let bundle = bundles.get(source);
	if (!bundle) {
		const files = FILES.map(([name, path]) => [name, readFileSync(join(source, path))] as const);
		const hash = createHash("sha256");
		for (const [name, content] of files) hash.update(`${name}\0${content.length}\0`).update(content);
		bundle = { files, id: hash.digest("hex").slice(0, 16) };
		bundles.set(source, bundle);
	}
	return bundle;
}

/** The name of the launcher's directory on a host: the content hash of its files in `source`. */
export function launcherId(source: string): string {
	return bundleOf(source).id;
}

/** How long a deployment or one-shot command may take; `start` may download the guest image first. */
const COMMAND_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 660_000;

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The sandbox configuration the launcher takes: base64 JSON of what the VM needs. Secrets are named with their hosts
 * and versions, never their values (the command line is visible on the host): `start` reads those on stdin.
 */
export function sandboxArgument(config: GondolinEnvConfig, secrets: readonly SecretMeta[] = []): string {
	const value = {
		...(config.image === undefined ? {} : { image: config.image }),
		mounts: config.mounts ?? [],
		allowHosts: config.allowHosts ?? [],
		...(config.cpus === undefined ? {} : { cpus: config.cpus }),
		...(config.memoryMb === undefined ? {} : { memoryMb: config.memoryMb }),
		diskGb: config.diskGb ?? DEFAULT_DISK_GB,
		...(secrets.length ? { secrets } : {}),
	};
	return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** The configuration's revision as the launcher reports it for the running VM (it applies at the next start). */
export function sandboxRevision(config: GondolinEnvConfig, secrets: readonly SecretMeta[] = []): string {
	return createHash("sha256").update(sandboxArgument(config, secrets)).digest("hex").slice(0, 16);
}

/** The remote command line that runs the launcher in `directory` with `args`. */
export function runLauncher(directory: string, args: readonly string[]): string {
	return ["sh", quote(`${directory}/p2-sandbox.sh`), ...args.map(quote)].join(" ");
}

/** Run `command` on the host over SSH, optionally feeding `input`; resolves with stdout, rejects with stderr. */
function runOnHost(
	target: SshTarget,
	command: string,
	input?: string,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(target.ssh ?? "ssh", [...sshArguments(target), command], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const stderr = Buffer.concat(err).toString("utf8").trim();
			if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
			else reject(new Error(stderr || `ssh exited with code ${code}`));
		});
		child.stdin.end(input ?? "");
	});
}

/**
 * Make sure this launcher is on the host and return its directory. One round trip: the script checks the files'
 * hashes (a changed file is written again) and writes a missing or changed directory through a temporary one renamed
 * into place. Other versions stay (other p2 installations may use them) until unused for 30 days.
 */
export async function deployLauncher(target: SshTarget, remote: RemotePlatform, source: string): Promise<string> {
	const bundle = bundleOf(source);
	const root = `${remote.home}/.pi/p2/sandbox`;
	const directory = `${root}/${bundle.id}`;
	const sha = (content: Buffer) => createHash("sha256").update(content).digest("hex");
	const script = [
		"set -e",
		`d=${quote(directory)}`,
		`r=${quote(root)}`,
		'hash() { sha256sum "$1" 2>/dev/null | cut -d" " -f1; }',
		"intact() {",
		'\t[ -f "$d/.complete" ] || return 1',
		...bundle.files.map(([name, content]) => `\t[ "$(hash "$d/${name}")" = ${sha(content)} ] || return 1`),
		"}",
		"if ! intact; then",
		'\tmkdir -p "$r"',
		'\tt=$(mktemp -d "$d.XXXXXX")',
		...bundle.files.map(
			([name, content]) => `\tprintf %s ${quote(content.toString("base64"))} | base64 -d > "$t/${name}"`,
		),
		'\tchmod 755 "$t/p2-sandbox.sh"',
		'\ttouch "$t/.complete"',
		'\trm -rf "$d"',
		'\tmv "$t" "$d"',
		"fi",
		'touch "$d"',
		'find "$r" -mindepth 1 -maxdepth 1 -type d -name "????????????????" -mtime +30 -exec rm -rf {} +',
	].join("\n");
	await runOnHost(target, "sh -s", `${script}\n`);
	return directory;
}

/**
 * The name a sandbox's VM has on its host: the sandbox's name, prefixed by this p2 installation (its machine and data
 * directory), so two installations with a sandbox of the same name on one host never share a VM.
 */
export function sandboxKey(directory: string, name: string): string {
	return `${createHash("sha256").update(`${hostname()}\0${directory}`).digest("hex").slice(0, 8)}.${name}`;
}

/** Run a launcher command on the host (deploying the launcher first) and parse its last line of output as JSON. */
export async function launcherCommand(
	target: SshTarget,
	remote: RemotePlatform,
	source: string,
	args: readonly string[],
	input?: string,
): Promise<unknown> {
	return deployedCommand(target, await deployLauncher(target, remote, source), args, input);
}

/**
 * Run a command of the launcher deployed in `directory` and parse its last line of output as JSON; `start` may take
 * minutes (a first start installs Gondolin and downloads the guest image).
 */
export async function deployedCommand(
	target: SshTarget,
	directory: string,
	args: readonly string[],
	input?: string,
): Promise<unknown> {
	const timeoutMs = args[0] === "start" ? START_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
	const output = await runOnHost(target, runLauncher(directory, args), input, timeoutMs);
	const line = output.trim().split("\n").at(-1) ?? "";
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`Unexpected answer from the sandbox launcher: ${line.slice(0, 200)}`);
	}
}
