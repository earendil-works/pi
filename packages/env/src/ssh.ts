import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, type ConnectionOptions } from "./connection.ts";

/** A remote system the package ships a daemon for. */
export type RemotePlatform = {
	platform: "linux" | "android" | "darwin" | "windows";
	arch: "x64" | "arm64";
	/** The remote home directory, in the remote system's own spelling. */
	home: string;
	/** Windows: the shell `sshd` runs commands with (`DefaultShell`). */
	shell?: "cmd" | "powershell";
	/** Problems worth telling the owner about, such as Termux without `termux-exec`. */
	warnings: string[];
};

/** How to reach a machine with the system `ssh`. */
export interface SshTarget {
	/** Host name or `~/.ssh/config` alias. */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Host keys this application trusts; `acceptHostKey` adds to it. */
	knownHostsFile: string;
	/** The name keys are stored under, independent of aliases, ports and jump hosts, e.g. `pi-env-<env name>`. */
	hostKeyAlias: string;
	/** The `ssh` program; default `ssh`. */
	ssh?: string;
	/** An `ssh` configuration file instead of `~/.ssh/config` (`-F`). */
	configFile?: string;
}

/** The remote host's key is not in `knownHostsFile`; `scanHostKey` shows it so the owner can accept it. */
export class HostKeyUnknownError extends Error {}

/** The remote host's key differs from the one in `knownHostsFile`; it is never accepted automatically. */
export class HostKeyChangedError extends Error {}

/** An `ssh` invocation that failed for another reason, with its exit code and diagnostics. */
export class SshError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(message: string, exitCode: number | null, stderr: string) {
		super(message);
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** No leading `-` (it would be read as an `ssh` option) and no whitespace or control characters. */
function checkField(name: string, value: string): void {
	if (value === "" || value.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(value)) {
		throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
	}
}

/** A path for an `ssh` option that expands `%` tokens: quoted, with `%` literal. */
function configPath(name: string, path: string): string {
	if (path === "" || /["\x00-\x1f\x7f]/.test(path)) throw new Error(`Invalid ${name}: ${JSON.stringify(path)}`);
	return `"${path.replaceAll("%", "%%")}"`;
}

/**
 * Arguments for `ssh` up to the host: no prompts, no forwarding of any kind, no shared connections, no commands from
 * the configuration, no locale forwarding (the remote uses its own), and host keys checked strictly against the
 * application's own file under a fixed alias.
 */
export function sshArguments(
	target: SshTarget,
	strictHostKeys = true,
	knownHostsFile = target.knownHostsFile,
): string[] {
	checkField("host", target.host);
	checkField("host key alias", target.hostKeyAlias);
	if (target.user !== undefined) checkField("user", target.user);
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
		throw new Error(`Invalid port: ${target.port}`);
	}
	const option = (setting: string) => ["-o", setting];
	return [
		...(target.configFile === undefined ? [] : ["-F", target.configFile]),
		"-T",
		"-a",
		"-x",
		...option("BatchMode=yes"),
		...option("ClearAllForwardings=yes"),
		...option("ForwardAgent=no"),
		...option("ForwardX11=no"),
		...option("ControlMaster=no"),
		...option("ControlPath=none"),
		...option("RemoteCommand=none"),
		...option("PermitLocalCommand=no"),
		...option("SendEnv=-*"),
		...option("ServerAliveInterval=15"),
		...option(`StrictHostKeyChecking=${strictHostKeys ? "yes" : "accept-new"}`),
		...option(`UserKnownHostsFile=${configPath("known hosts file", knownHostsFile)}`),
		...option("GlobalKnownHostsFile=none"),
		...option("HashKnownHosts=no"),
		...option(`HostKeyAlias=${target.hostKeyAlias}`),
		...(target.user === undefined ? [] : ["-l", target.user]),
		...(target.port === undefined ? [] : ["-p", String(target.port)]),
		...(target.identityFile === undefined
			? []
			: [
					...option(`IdentityFile=${configPath("identity file", target.identityFile)}`),
					...option("IdentitiesOnly=yes"),
				]),
		"--",
		target.host,
	];
}

/** How long a detection, check or upload over `ssh` may take before it is abandoned. */
const SSH_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** Run one remote command over `ssh`, optionally feeding stdin; resolves with stdout, rejects on failure. */
function runSsh(
	target: SshTarget,
	command: string,
	options: { stdin?: Uint8Array; args?: string[]; timeoutMs?: number } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = options.args ?? sshArguments(target);
		const child = spawn(target.ssh ?? "ssh", [...args, command], { stdio: ["pipe", "pipe", "pipe"] });
		const timeoutMs = options.timeoutMs ?? SSH_TIMEOUT_MS;
		const timer = setTimeout(() => {
			child.kill();
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			reject(
				new SshError(
					`ssh ${target.host} did not finish within ${timeoutMs / 1000} s: ${diagnostics.trim()}`,
					null,
					diagnostics,
				),
			);
		}, timeoutMs);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new SshError(error.message, null, ""));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const output = Buffer.concat(stdout).toString("utf8");
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			if (code === 0) return resolve(output);
			if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(diagnostics)) {
				return reject(
					new HostKeyChangedError(`The host key of ${target.host} changed; remove the old key to continue`),
				);
			}
			if (/Host key verification failed|No .* host key is known/.test(diagnostics)) {
				return reject(new HostKeyUnknownError(`The host key of ${target.host} is not trusted yet`));
			}
			reject(
				new SshError(`ssh ${target.host} failed with exit code ${code}: ${diagnostics.trim()}`, code, diagnostics),
			);
		});
		child.stdin.end(options.stdin ?? new Uint8Array(0));
	});
}

/**
 * Connect once with `accept-new` against a temporary known-hosts file to capture the key the host presents, through
 * the same route (`~/.ssh/config`, jump hosts) as real connections. Returns its known-hosts lines and fingerprints.
 * Showing a fingerprint is not authentication: compare it with one obtained out of band before accepting it.
 */
export async function scanHostKey(target: SshTarget): Promise<{ lines: string[]; fingerprints: string[] }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-env-hostkey-"));
	try {
		const scanned = join(directory, "known_hosts");
		// Authentication may fail without the key; the key is recorded before authentication.
		await runSsh(target, "exit 0", { args: sshArguments(target, false, scanned) }).catch((error: unknown) => {
			if (!(error instanceof SshError) && !(error instanceof HostKeyUnknownError)) throw error;
		});
		const lines = existsSync(scanned)
			? (await readFile(scanned, "utf8")).split("\n").filter((line) => line.trim() !== "")
			: [];
		if (lines.length === 0) throw new Error(`No host key received from ${target.host}`);
		const fingerprints = await new Promise<string[]>((resolve, reject) => {
			const child = spawn("ssh-keygen", ["-lf", scanned], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", () => resolve(output.split("\n").filter((line) => line.trim() !== "")));
		});
		return { lines, fingerprints };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** A known-hosts line for `alias`: `alias type key [comment]`, no markers, patterns or hashed names. */
function parseHostKeyLine(alias: string, line: string): { type: string; key: string } {
	const [host, type, key] = line.trim().split(/\s+/);
	if (
		host !== alias ||
		type === undefined ||
		key === undefined ||
		!/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/.test(type) ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(key)
	) {
		throw new Error(`Not a host key line for ${alias}: ${JSON.stringify(line)}`);
	}
	return { type, key };
}

/** Known-hosts files being changed, so changes to one file happen one at a time. */
const knownHostsChanges = new Map<string, Promise<unknown>>();

/** Rewrite the known-hosts file one change at a time, atomically. */
async function changeKnownHosts(file: string, change: (lines: string[]) => string[]): Promise<void> {
	const previous = knownHostsChanges.get(file) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			const existing = existsSync(file)
				? (await readFile(file, "utf8")).split("\n").filter((line) => line !== "")
				: [];
			const lines = change(existing);
			const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
			await writeFile(temporary, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
			await rename(temporary, file).catch(async (error: unknown) => {
				await rm(temporary, { force: true });
				throw error;
			});
		});
	knownHostsChanges.set(file, next);
	try {
		await next;
	} finally {
		if (knownHostsChanges.get(file) === next) knownHostsChanges.delete(file);
	}
}

/**
 * Trust host-key lines from `scanHostKey` by adding them to the target's known-hosts file. Only plain lines for the
 * target's alias are accepted. A key that differs from a trusted key of the same type is refused with
 * `HostKeyChangedError`; `forgetHostKey` must remove the old keys first.
 */
export async function acceptHostKey(target: SshTarget, lines: readonly string[]): Promise<void> {
	const alias = target.hostKeyAlias;
	const accepted = lines.map((line) => ({ line: line.trim(), ...parseHostKeyLine(alias, line) }));
	await changeKnownHosts(target.knownHostsFile, (existing) => {
		const trusted = new Map<string, string>();
		for (const line of existing) {
			const [host, type, key] = line.trim().split(/\s+/);
			if (host === alias && type !== undefined && key !== undefined) trusted.set(type, key);
		}
		const added: string[] = [];
		for (const { line, type, key } of accepted) {
			const known = trusted.get(type);
			if (known === key) continue;
			if (known !== undefined) {
				throw new HostKeyChangedError(`The ${type} host key of ${target.host} changed; forget the old key first`);
			}
			trusted.set(type, key);
			added.push(line);
		}
		return [...existing, ...added];
	});
}

/** Stop trusting every key stored for the target's alias, e.g. after the owner confirmed a changed host key. */
export async function forgetHostKey(target: SshTarget): Promise<void> {
	await changeKnownHosts(target.knownHostsFile, (existing) =>
		existing.filter((line) => line.trim().split(/\s+/)[0] !== target.hostKeyAlias),
	);
}

/** POSIX detection, run by the remote login shell; a Windows host answers through PowerShell instead. */
const POSIX_PROBE = `sh -c 'echo PI-ENV-PROBE; uname -s; uname -m; uname -o 2>/dev/null || echo -; printf "%s\\n" "$HOME" "\${TMPDIR:--}" "\${LD_PRELOAD:--}"'`;

function powershell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

const WINDOWS_PROBE = powershell(
	"'PI-ENV-PROBE'; 'Windows'; [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); '-'; $HOME; '-'; '-'",
);

function normalizeArch(machine: string): RemotePlatform["arch"] {
	const lower = machine.toLowerCase();
	if (lower === "x86_64" || lower === "amd64" || lower === "x64") return "x64";
	if (lower === "aarch64" || lower === "arm64") return "arm64";
	throw new Error(`Unsupported remote architecture: ${machine}`);
}

type Probe = { system: string; machine: string; os: string; home: string; tmpdir: string; preload: string };

function parseProbe(target: SshTarget, output: string): Probe {
	// Login shells may print a banner first.
	const lines = output.split(/\r?\n/);
	const start = lines.indexOf("PI-ENV-PROBE");
	if (start === -1) throw new Error(`Unexpected answer from ${target.host}: ${output.trim()}`);
	const [system = "", machine = "", os = "", home = "", tmpdir = "-", preload = "-"] = lines.slice(start + 1);
	return { system, machine, os, home, tmpdir, preload };
}

/** Termux works only with its own `TMPDIR` and with `termux-exec`, which makes `#!/usr/bin/env` shebangs work. */
function termuxWarnings(probe: Probe): string[] {
	const warnings: string[] = [];
	if (probe.tmpdir === "-") warnings.push("TMPDIR is not set; Termux's sshd normally sets it to $PREFIX/tmp.");
	if (!probe.preload.includes("termux-exec")) {
		warnings.push("termux-exec is not loaded (LD_PRELOAD); scripts with #!/usr/bin/env shebangs will fail.");
	}
	warnings.push("Android may suspend Termux; run termux-wake-lock on the device to keep the connection alive.");
	return warnings;
}

/** Which system the target runs: `uname` through the login shell, or PowerShell on Windows. */
export async function detectPlatform(target: SshTarget): Promise<RemotePlatform> {
	let probe: Probe;
	try {
		probe = parseProbe(target, await runSsh(target, POSIX_PROBE));
	} catch (error) {
		// cmd.exe or PowerShell as the remote shell: no `sh`, or one that gets the probe's quotes wrong.
		if (error instanceof HostKeyUnknownError || error instanceof HostKeyChangedError) throw error;
		probe = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	}
	// Git Bash as Windows' default SSH shell: ask PowerShell for Windows' own architecture and home spelling.
	if (/^(MINGW|MSYS|CYGWIN)/.test(probe.system)) probe = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	const arch = normalizeArch(probe.machine);
	const { system, os, home } = probe;
	if (system === "Windows") {
		// cmd.exe expands %OS%; PowerShell prints it as is.
		const shell = (await runSsh(target, "echo %OS%")).includes("Windows_NT") ? "cmd" : "powershell";
		return { platform: "windows", arch, home, shell, warnings: [] };
	}
	if (system === "Darwin") return { platform: "darwin", arch, home, warnings: [] };
	if (system === "Linux") {
		const android = os === "Android";
		return { platform: android ? "android" : "linux", arch, home, warnings: android ? termuxWarnings(probe) : [] };
	}
	throw new Error(`Unsupported remote system: ${system}`);
}

/** The daemon binary this package ships for a remote system. */
export function packagedDaemon(remote: Pick<RemotePlatform, "platform" | "arch">): string {
	const name = `pi-env-${remote.platform}-${remote.arch}`;
	return join(packageRoot, "bin", name, remote.platform === "windows" ? "pi-env.exe" : "pi-env");
}

function quotePosix(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

/** Where a daemon with this content lives on the remote machine: named by its SHA-256, so versions never collide. */
function daemonPath(remote: RemotePlatform, sha256: string): string {
	const name = `pi-env-${sha256.slice(0, 32)}`;
	return remote.platform === "windows"
		? `${remote.home}\\.pi\\mobile\\tools\\${name}.exe`
		: `${remote.home}/.pi/mobile/tools/${name}`;
}

const POSIX_HASH = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; else echo none; fi; }`;

/** Whether the remote file has this content: `present`, `missing`, or (POSIX without a hash tool) `nohash`. */
async function checkDaemon(target: SshTarget, remote: RemotePlatform, file: string, sha256: string): Promise<string> {
	if (remote.platform === "windows") {
		const check = powershell(
			`$f = ${quotePowerShell(file)}; if ((Test-Path -LiteralPath $f) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -eq '${sha256}')) { 'present' } else { 'missing' }`,
		);
		return (await runSsh(target, check)).trim().endsWith("present") ? "present" : "missing";
	}
	const check = `${POSIX_HASH}; f=${quotePosix(file)}; if [ -f "$f" ] && [ "$(hash "$f")" = ${sha256} ]; then echo present; elif [ "$(hash /dev/null)" = none ]; then echo nohash; else echo missing; fi`;
	return (await runSsh(target, `sh -c ${quotePosix(check)}`)).trim().split("\n").at(-1) ?? "missing";
}

/**
 * Make sure the daemon is on the remote machine, verified by its SHA-256 before it ever runs, and remove daemons of
 * other contents. The upload goes to a new temporary file and is renamed into place only once its hash matches.
 * Returns the remote path of the binary.
 */
export async function deployDaemon(
	target: SshTarget,
	remote: RemotePlatform,
	binary = packagedDaemon(remote),
): Promise<string> {
	if (!existsSync(binary)) throw new Error(`No pi-env daemon for ${remote.platform}-${remote.arch} at ${binary}`);
	const bytes = await readFile(binary);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const file = daemonPath(remote, sha256);
	const state = await checkDaemon(target, remote, file, sha256);
	if (state === "present") return file;
	if (state === "nohash") throw new Error(`${target.host} has no sha256sum, shasum or openssl to verify pi-env`);
	if (remote.platform === "windows") {
		const upload = powershell(
			[
				"$ErrorActionPreference = 'Stop'",
				`$f = ${quotePowerShell(file)}`,
				"$d = Split-Path -Parent $f",
				"New-Item -ItemType Directory -Force -Path $d | Out-Null",
				"$t = Join-Path $d ('.pi-env-' + [guid]::NewGuid().ToString() + '.tmp')",
				// PowerShell reads redirected stdin itself, as text lines for `$input`, so the binary comes as base64 lines
				// up to an end marker: Windows' sshd may never pass on the end of stdin.
				"$text = New-Object System.Text.StringBuilder",
				"foreach ($line in $input) { if ($line -eq 'PI-ENV-END') { break }; [void]$text.Append($line) }",
				"$bytes = [Convert]::FromBase64String($text.ToString())",
				"$out = [IO.File]::Open($t, 'CreateNew', 'Write', 'None'); $out.Write($bytes, 0, $bytes.Length); $out.Close()",
				`if ((Get-FileHash -Algorithm SHA256 -LiteralPath $t).Hash.ToLower() -ne '${sha256}') { Remove-Item -LiteralPath $t; throw 'pi-env upload is corrupt' }`,
				// A running daemon or a virus scanner can hold the old file for a moment.
				"for ($i = 0; ; $i++) { try { Move-Item -Force -LiteralPath $t -Destination $f; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 250 } }",
				// Older daemons; one that is running stays until it exits.
				"Get-ChildItem -LiteralPath $d -Filter 'pi-env-*.exe' | Where-Object { $_.FullName -ne $f } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue }",
				"'deployed'",
			].join("; "),
		);
		const lines = bytes.toString("base64").replace(/.{1,76}/g, "$&\n");
		await runSsh(target, upload, { stdin: Buffer.from(`${lines}PI-ENV-END\n`), timeoutMs: UPLOAD_TIMEOUT_MS });
		return file;
	}
	const upload = [
		"set -e",
		POSIX_HASH,
		`f=${quotePosix(file)}`,
		'd=$(dirname "$f")',
		'mkdir -p "$d"',
		'chmod 700 "$d"',
		't=$(mktemp "$d/.pi-env.XXXXXX")',
		'cat > "$t"',
		`if [ "$(hash "$t")" != ${sha256} ]; then rm -f "$t"; echo "pi-env upload is corrupt" >&2; exit 1; fi`,
		'chmod 700 "$t"',
		'mv -f "$t" "$f"',
		// Older daemons; running ones keep their file open until they exit.
		'for old in "$d"/pi-env-*; do [ "$old" = "$f" ] || rm -f "$old"; done',
		"echo deployed",
	].join("\n");
	await runSsh(target, `sh -c ${quotePosix(upload)}`, { stdin: bytes, timeoutMs: UPLOAD_TIMEOUT_MS });
	return file;
}

/** Options for `sshConnection` and `connectSsh`: the target, plus the binary to deploy (default: the one this package ships). */
export interface SshConnectOptions extends SshTarget {
	binary?: string;
	/**
	 * POSIX: start the daemon through the user's login shell (`$SHELL -l`), so commands see the environment of
	 * `~/.profile` and similar files. Off by default: `ssh` runs commands without a login shell.
	 */
	loginShell?: boolean;
	onLog?: ConnectionOptions["onLog"];
}

/** The remote command that starts the daemon at `file`, before the `serve` arguments. */
function launchCommand(remote: RemotePlatform, file: string, loginShell: boolean): string {
	if (remote.platform === "windows") {
		// PowerShell runs a quoted path only with the call operator; cmd.exe keeps one pair of quotes around a program.
		if (remote.shell === "powershell") return `& ${quotePowerShell(file)}`;
		return file.includes(" ") ? `"${file}"` : file;
	}
	// `$0` is the daemon, `"$@"` its arguments; `$SHELL` is the login shell's own name for itself.
	if (loginShell) return `exec "$SHELL" -lc 'exec "$0" "$@"' ${quotePosix(file)}`;
	return quotePosix(file);
}

/** What an SSH connection learned about its remote system, and the daemon it verified last. */
type SshState = { remote?: RemotePlatform; verified?: string };

/** A `Connection` whose every start detects the remote system (once), verifies or deploys the daemon, then starts it. */
function sshConnectionFor(options: SshConnectOptions, state: SshState): Connection {
	return new Connection({
		command: async () => {
			if (state.remote === undefined) {
				const remote = await detectPlatform(options);
				for (const warning of remote.warnings) options.onLog?.(`${warning}\n`);
				state.remote = remote;
			}
			// A deployment that just verified the binary counts for the first start.
			const file =
				state.verified ??
				(await deployDaemon(options, state.remote, options.binary ?? packagedDaemon(state.remote)));
			state.verified = undefined;
			return [
				options.ssh ?? "ssh",
				...sshArguments(options),
				launchCommand(state.remote, file, options.loginShell === true),
			];
		},
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
}

/**
 * A `Connection` to the target that does nothing until its first request. Each start detects the remote system (the
 * first time), verifies the daemon and deploys it if it is missing or changed, then starts it over `ssh`. A failure
 * (no network, an untrusted or changed host key) fails the requests waiting for that start with code `spawn_error`
 * and the `ssh` diagnostics as message; the next request tries again. `remote()` is the detected system, once known.
 */
export function sshConnection(options: SshConnectOptions): {
	connection: Connection;
	remote(): RemotePlatform | undefined;
} {
	const state: SshState = {};
	return { connection: sshConnectionFor(options, state), remote: () => state.remote };
}

/**
 * Detect the remote system and deploy the daemon now, then return a `Connection` that starts it over `ssh`, like
 * `sshConnection`. Failures reject here: host keys must already be trusted (`scanHostKey`, `acceptHostKey`), otherwise
 * this rejects with `HostKeyUnknownError`.
 */
export async function connectSsh(
	options: SshConnectOptions,
): Promise<{ connection: Connection; remote: RemotePlatform }> {
	const remote = await detectPlatform(options);
	const verified = await deployDaemon(options, remote, options.binary ?? packagedDaemon(remote));
	for (const warning of remote.warnings) options.onLog?.(`${warning}\n`);
	return { connection: sshConnectionFor(options, { remote, verified }), remote };
}
