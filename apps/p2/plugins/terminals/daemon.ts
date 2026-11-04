import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, RemoteError } from "@earendil-works/pi-env";

// Terminals need a pi-env daemon with the `pty` operation (packages/env): a shipped or development build, or
// P2_TERMINAL_DAEMON for this machine.

const envPackage = fileURLToPath(new URL("../../../../packages/env/", import.meta.url));

/** Rust targets of the release builds (.github/workflows/env-daemons.yml). */
const TARGETS: Record<string, string> = {
	"linux-x64": "x86_64-unknown-linux-musl",
	"linux-arm64": "aarch64-unknown-linux-musl",
	"android-x64": "x86_64-linux-android",
	"android-arm64": "aarch64-linux-android",
	"darwin-x64": "x86_64-apple-darwin",
	"darwin-arm64": "aarch64-apple-darwin",
};

/** This machine, as pi-env names systems. */
export function localSystem(): { platform: string; arch: string } {
	return { platform: process.platform === "win32" ? "windows" : process.platform, arch: process.arch };
}

/** The daemon binary for a system; `local` for this machine, which may also use a development build. */
export async function terminalDaemon(platform: string, arch: string, local: boolean): Promise<string> {
	const system = `${platform}-${arch}`;
	if (platform === "windows") throw new Error("Terminals are not supported on Windows yet");
	const target = TARGETS[system];
	const native = platform === localSystem().platform && arch === process.arch;
	const candidates = [
		local ? process.env.P2_TERMINAL_DAEMON : undefined,
		target ? join(envPackage, "daemon", "target", target, "release", "pi-env") : undefined,
		native ? join(envPackage, "daemon", "target", "release", "pi-env") : undefined,
		native ? join(envPackage, "daemon", "target", "debug", "pi-env") : undefined,
		join(envPackage, "bin", `pi-env-${system}`, "pi-env"),
	];
	const failures: string[] = [];
	for (const candidate of candidates) {
		if (!candidate || !existsSync(candidate)) continue;
		// Foreign binaries cannot run here; their SSH connection is checked before use instead.
		if (!native) return candidate;
		const connection = new Connection({ command: [candidate] });
		try {
			await requireTerminalSupport(connection);
			return candidate;
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			connection.close();
		}
	}
	throw new Error(
		local
			? `No pi-env daemon with terminal support: run \`npm run build:daemon\` in packages/env, or set P2_TERMINAL_DAEMON${failures.length ? ` (${failures.join("; ")})` : ""}`
			: `No pi-env daemon with terminal support for ${system}: build packages/env/daemon with \`cargo build --release --target ${target ?? "<target>"}\``,
	);
}

/** Probe the operation, not the version: released 1.1.0 binaries predate PTY support. No process is spawned. */
export async function requireTerminalSupport(connection: Pick<Connection, "request">): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			connection.request("pty", { cwd: "", cols: 0, rows: 0 }).then(
				() => {
					throw new Error("pi-env accepted an invalid terminal size");
				},
				(error: unknown) => {
					if (
						error instanceof RemoteError &&
						error.code === "EINVAL" &&
						/^cols must be between /.test(error.message)
					)
						return;
					throw error;
				},
			),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("pi-env terminal capability probe timed out")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
