import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	ChevronIcon,
	CopyButton,
	conversationRoute,
	errorText,
	LockIcon,
	PlusIcon,
	pressVerb,
	Sheet,
	SlotList,
	upperFirst,
	useNavigation,
	useObject,
	useOptimisticCall,
	usePointerKind,
	useReadable,
} from "@p2/app/v1/web";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
	type Enrollment,
	type EnvSummary,
	Envs,
	type EnvTest,
	type EnvUser,
	type Installed,
	installedReady,
	type RadiusMachine,
	type SandboxStatus,
} from "./contract.ts";
import { SecretsSection } from "./SecretsSection.tsx";
import {
	DEFAULT_DISK_GB,
	ENV_NAME,
	type EnvConfig,
	type GondolinEnvConfig,
	type RadiusEnvConfig,
	type SandboxMount,
	type SshEnvConfig,
} from "./schema.ts";

type SshDraft = {
	name: string;
	host: string;
	user: string;
	port: string;
	identityFile: string;
	shellPath: string;
	loginShell: boolean;
	shellEnv: string;
};
const EMPTY: SshDraft = {
	name: "",
	host: "",
	user: "",
	port: "",
	identityFile: "",
	shellPath: "",
	loginShell: false,
	shellEnv: "",
};
function sshDraftOf(name: string, config: SshEnvConfig): SshDraft {
	return {
		name,
		host: config.host,
		user: config.user ?? "",
		port: config.port === undefined ? "" : String(config.port),
		identityFile: config.identityFile ?? "",
		shellPath: config.shellPath ?? "",
		loginShell: config.loginShell ?? false,
		shellEnv: shellEnvText(config.shellEnv),
	};
}
/** `KEY=value` lines as the form shows them. */
const shellEnvText = (shellEnv: Record<string, string> | undefined): string =>
	Object.entries(shellEnv ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
/** The form's `KEY=value` lines. */
function parseShellEnv(text: string): Record<string, string> {
	const shellEnv: Record<string, string> = {};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const separator = line.indexOf("=");
		if (separator < 1) throw new Error(`Environment variables are KEY=value lines: ${line}`);
		shellEnv[line.slice(0, separator).trim()] = line.slice(separator + 1);
	}
	return shellEnv;
}
function sshConfigOf(draft: SshDraft): EnvConfig {
	const shellEnv = parseShellEnv(draft.shellEnv);
	if (draft.port && !/^\d+$/.test(draft.port.trim())) throw new Error("Port must be a number");
	return {
		type: "ssh",
		host: draft.host.trim(),
		...(draft.user.trim() ? { user: draft.user.trim() } : {}),
		...(draft.port.trim() ? { port: Number(draft.port) } : {}),
		...(draft.identityFile.trim() ? { identityFile: draft.identityFile.trim() } : {}),
		...(draft.shellPath.trim() ? { shellPath: draft.shellPath.trim() } : {}),
		...(draft.loginShell ? { loginShell: true } : {}),
		...(Object.keys(shellEnv).length ? { shellEnv } : {}),
	};
}
/** A machine running `pi-env agent`, reached through Radius: its server and the shell settings commands get. */
type RadiusDraft = { name: string; server: string; shellPath: string; loginShell: boolean; shellEnv: string };
function radiusDraftOf(name: string, config: RadiusEnvConfig): RadiusDraft {
	return {
		name,
		server: config.server,
		shellPath: config.shellPath ?? "",
		loginShell: config.loginShell ?? false,
		shellEnv: shellEnvText(config.shellEnv),
	};
}
function radiusConfigOf(draft: RadiusDraft): EnvConfig {
	const shellEnv = parseShellEnv(draft.shellEnv);
	return {
		type: "radius",
		server: draft.server,
		...(draft.shellPath.trim() ? { shellPath: draft.shellPath.trim() } : {}),
		...(draft.loginShell ? { loginShell: true } : {}),
		...(Object.keys(shellEnv).length ? { shellEnv } : {}),
	};
}
/** An environment name for a machine Radius names `name`: lowercase letters, digits, - and _ (at most 32). */
function envNameFor(name: string | undefined): string {
	const base = (name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+/, "")
		.slice(0, 32)
		.replace(/[-_]+$/, "");
	return ENV_NAME.test(base) ? base : "machine";
}

/** An environment saved or deleted while its call is in flight. */
type EnvGuess =
	| { readonly kind: "save"; readonly name: string; readonly config: EnvConfig }
	| { readonly kind: "delete"; readonly name: string };

/** The list with a save (a new row, or the row's new configuration) or a deletion applied. */
function applyEnv(envs: EnvSummary[] | undefined, guess: EnvGuess): EnvSummary[] | undefined {
	if (!envs) return envs;
	if (guess.kind === "delete") return envs.filter((env) => env.name !== guess.name);
	const saved = envs.find((env) => env.name === guess.name);
	return saved
		? envs.map((env) => (env === saved ? { ...env, config: guess.config } : env))
		: [...envs, { name: guess.name, config: guess.config, sessions: 0 }];
}

type SandboxDraft = {
	name: string;
	host: string;
	image: string;
	mounts: SandboxMount[];
	allowHosts: string;
	cpus: string;
	memoryMb: string;
	diskGb: string;
};
function sandboxDraftOf(name: string, config: GondolinEnvConfig): SandboxDraft {
	return {
		name,
		host: config.host,
		image: config.image ?? "",
		mounts: config.mounts ?? [],
		allowHosts: (config.allowHosts ?? []).join("\n"),
		cpus: config.cpus === undefined ? "" : String(config.cpus),
		memoryMb: config.memoryMb === undefined ? "" : String(config.memoryMb),
		diskGb: config.diskGb === undefined ? "" : String(config.diskGb),
	};
}
function sandboxConfigOf(draft: SandboxDraft): EnvConfig {
	const number = (value: string, label: string) => {
		if (!/^\d+$/.test(value.trim())) throw new Error(`${label} must be a number`);
		return Number(value.trim());
	};
	const allowHosts = draft.allowHosts
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return {
		type: "gondolin",
		host: draft.host,
		...(draft.image.trim() ? { image: draft.image.trim() } : {}),
		...(draft.mounts.length ? { mounts: draft.mounts } : {}),
		...(allowHosts.length ? { allowHosts } : {}),
		...(draft.cpus.trim() ? { cpus: number(draft.cpus, "CPUs") } : {}),
		...(draft.memoryMb.trim() ? { memoryMb: number(draft.memoryMb, "Memory") } : {}),
		...(draft.diskGb.trim() ? { diskGb: number(draft.diskGb, "Disk") } : {}),
	};
}

/** The edited screen: an SSH environment, a sandbox or a Radius machine, new or saved. */
type Editing =
	| { kind: "ssh"; draft: SshDraft; existing: boolean }
	| { kind: "gondolin"; draft: SandboxDraft; existing: boolean }
	| { kind: "radius"; draft: RadiusDraft; existing: boolean };
function editingOf(env: EnvSummary): Editing {
	if (env.config.type === "ssh") return { kind: "ssh", draft: sshDraftOf(env.name, env.config), existing: true };
	if (env.config.type === "radius")
		return { kind: "radius", draft: radiusDraftOf(env.name, env.config), existing: true };
	return { kind: "gondolin", draft: sandboxDraftOf(env.name, env.config), existing: true };
}
/** Locator prefix of a new sandbox's screen, followed by its preset host (env names cannot start with `+`). */
const NEW_SANDBOX = "+sandbox:";

/** A sandbox's VM as last read; `unknown` when reading it failed. */
type VmState = SandboxStatus | { state: "unknown"; error: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function uptime(startedAt: number): string {
	const minutes = Math.floor((Date.now() - startedAt) / 60_000);
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
	return `${Math.floor(minutes / 1440)} d`;
}
/** A list row's word on an environment's last test. */
const testSummary = (test: EnvTest | undefined): string =>
	test === undefined ? "Not tested" : test.ok ? `${test.platform} · ${test.latencyMs} ms` : "Failed";

/** Whether an SSH env's last test found a runtime for sandboxes. */
function hostsSandboxes(env: EnvSummary): boolean {
	return env.test?.ok === true && env.test.sandboxes !== undefined && env.test.sandboxes.runtime !== "none";
}

function TestResult({
	test,
	busy,
	onAccept,
	onForget,
}: {
	test: EnvTest;
	busy: boolean;
	onAccept: (lines: string[]) => void;
	onForget: () => void;
}) {
	if (test.ok)
		return (
			<>
				<div className="notice env-test">
					<p>
						<strong>Connected</strong> · {test.platform} {test.arch} · pi-env {test.version} · {test.latencyMs} ms
					</p>
					<p className="muted small mono">{test.home}</p>
					<p className="muted small">
						Files are watched {test.watchMode === "native" ? "natively" : "by polling (no native change events)"}.
					</p>
					{test.warnings.map((warning) => (
						<p key={warning} className="small">
							⚠ {warning}
						</p>
					))}
				</div>
				{test.sandboxes && (
					<div className="notice env-test">
						<p>
							{test.sandboxes.runtime === "none" ? (
								<strong>Sandboxes: not available</strong>
							) : (
								<strong>Sandboxes: ready</strong>
							)}
						</p>
						{test.sandboxes.detail && <p className="muted small">{test.sandboxes.detail}</p>}
					</div>
				)}
			</>
		);
	return (
		<div className="notice error env-test">
			<p>{test.error}</p>
			{test.hostKey?.state === "unknown" && (
				<>
					<p className="small">
						The host presents this key. Compare its fingerprint with one obtained from the host itself (for
						example <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span> there) before
						accepting it.
					</p>
					{test.hostKey.fingerprints.map((fingerprint) => (
						<p key={fingerprint} className="mono small env-fingerprint">
							{fingerprint}
						</p>
					))}
					{test.hostKey.lines.length > 0 && (
						<button
							type="button"
							className="button"
							disabled={busy}
							onClick={() => onAccept(test.hostKey?.lines ?? [])}
						>
							Trust this key
						</button>
					)}
				</>
			)}
			{test.hostKey?.state === "changed" && (
				<>
					<p className="small">
						The host's key differs from the trusted one. This happens after reinstalling the host, but also when
						someone intercepts the connection. Forget the old key only if you know why it changed.
					</p>
					<button type="button" className="text-action danger" disabled={busy} onClick={onForget}>
						Forget old key
					</button>
				</>
			)}
		</div>
	);
}

function KeySection({
	service,
	name,
	onKey,
}: {
	service: Held<typeof Envs>;
	name: string;
	onKey: (identityFile: string) => void;
}) {
	const [publicKey, setPublicKey] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const valid = ENV_NAME.test(name);
	// Looked up once typing pauses (Pi Mobile waits 300 ms), not on every keystroke.
	useEffect(() => {
		let current = true;
		setPublicKey(undefined);
		if (!valid) return;
		const timer = setTimeout(() => {
			void service
				.publicKey({ name }, BACKGROUND_CONTEXT)
				.then((key) => {
					if (current) setPublicKey(key ?? undefined);
				})
				.catch(() => {});
		}, 300);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [service, name, valid]);
	const run = async (operation: () => Promise<{ publicKey: string; identityFile: string }>) => {
		setBusy(true);
		setError(undefined);
		try {
			const key = await operation();
			setPublicKey(key.publicKey);
			onKey(key.identityFile);
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="stack env-key">
			<span className="label">SSH key</span>
			{publicKey ? (
				<>
					<p className="muted small">
						Add this public key to <span className="mono">~/.ssh/authorized_keys</span> on the host, or to the SSH
						keys of your hosting provider's console.
					</p>
					<textarea
						className="input mono"
						rows={3}
						readOnly
						value={publicKey}
						onFocus={(event) => event.target.select()}
					/>
					<CopyButton text={publicKey} label="Copy public key" />
				</>
			) : (
				<p className="muted small">
					Generate a key on the server (it stays in its private data directory), or use an existing identity file
					or SSH-agent key.
				</p>
			)}
			<div className="inline-form">
				{!publicKey && (
					<button
						type="button"
						className="button"
						disabled={busy || !valid}
						onClick={() => void run(() => service.generateKey({ name }, BACKGROUND_CONTEXT))}
					>
						Generate key
					</button>
				)}
				<label className="button">
					Upload private key
					<input
						type="file"
						hidden
						disabled={busy || !valid}
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (!file) return;
							void run(async () => {
								if (file.size > 16384) throw new Error("Private key too large");
								return service.uploadKey({ name, key: await file.text() }, BACKGROUND_CONTEXT);
							});
						}}
					/>
				</label>
			</div>
			{!valid && <p className="muted small">Enter the environment's name first; the key is stored under it.</p>}
			<p className="muted small">
				Uploads pass through your tunnel or relay. Use a trusted transport for private keys.
			</p>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

function NameField({
	value,
	placeholder,
	onChange,
}: {
	value: string;
	placeholder: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="field">
			<span className="label">Name</span>
			<input
				className="input mono"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				{...NO_AUTOCORRECT}
				required
			/>
		</label>
	);
}

function SshFields({
	draft,
	existing,
	update,
}: {
	draft: SshDraft;
	existing: boolean;
	update: (patch: Partial<SshDraft>) => void;
}) {
	return (
		<>
			{!existing && <NameField value={draft.name} placeholder="gpu" onChange={(name) => update({ name })} />}
			<label className="field">
				<span className="label">Host (name or ~/.ssh/config alias)</span>
				<input
					className="input mono"
					value={draft.host}
					onChange={(event) => update({ host: event.target.value })}
					placeholder="gpu-box"
					{...NO_AUTOCORRECT}
					required
				/>
			</label>
			<div className="env-row">
				<label className="field">
					<span className="label">User</span>
					<input
						className="input mono"
						value={draft.user}
						onChange={(event) => update({ user: event.target.value })}
						{...NO_AUTOCORRECT}
					/>
				</label>
				<label className="field env-port">
					<span className="label">Port</span>
					<input
						className="input mono"
						value={draft.port}
						onChange={(event) => update({ port: event.target.value })}
						inputMode="numeric"
						placeholder="22"
					/>
				</label>
			</div>
			<label className="field">
				<span className="label">Identity file</span>
				<input
					className="input mono"
					value={draft.identityFile}
					onChange={(event) => update({ identityFile: event.target.value })}
					placeholder="~/.ssh/id_ed25519"
					{...NO_AUTOCORRECT}
				/>
			</label>
			<ShellFields draft={draft} update={update} />
			<label className="check">
				<input
					type="checkbox"
					checked={draft.loginShell}
					onChange={(event) => update({ loginShell: event.target.checked })}
				/>
				Start through the login shell (loads ~/.profile, e.g. Homebrew's PATH on macOS)
			</label>
		</>
	);
}

/** The shell commands run with and the variables they get, for SSH environments and Radius machines. */
function ShellFields({
	draft,
	update,
}: {
	draft: { shellPath: string; shellEnv: string };
	update: (patch: { shellPath?: string; shellEnv?: string }) => void;
}) {
	return (
		<>
			<label className="field">
				<span className="label">Shell for commands (default: bash, else sh)</span>
				<input
					className="input mono"
					value={draft.shellPath}
					onChange={(event) => update({ shellPath: event.target.value })}
					{...NO_AUTOCORRECT}
				/>
			</label>
			<label className="field">
				<span className="label">Environment variables (KEY=value per line)</span>
				<textarea
					className="input mono"
					rows={2}
					value={draft.shellEnv}
					onChange={(event) => update({ shellEnv: event.target.value })}
					{...NO_AUTOCORRECT}
				/>
			</label>
		</>
	);
}

/** A Radius machine's screen: which machine it is, and the shell settings. */
function RadiusFields({
	draft,
	existing,
	machine,
	update,
}: {
	draft: RadiusDraft;
	existing: boolean;
	machine: RadiusMachine | undefined;
	update: (patch: Partial<RadiusDraft>) => void;
}) {
	return (
		<>
			{!existing && <NameField value={draft.name} placeholder="laptop" onChange={(name) => update({ name })} />}
			<div className="notice env-test">
				<p>
					<strong>Radius machine</strong>
					{machine?.name ? ` · ${machine.name}` : ""}
					{machine ? ` · ${machine.status}` : ""}
				</p>
				<p className="muted small mono">{draft.server}</p>
				<p className="muted small">
					It runs pi-env agent as a service and is reached through Radius with this server's sign-in, never over
					SSH.
				</p>
			</div>
			<ShellFields draft={draft} update={update} />
		</>
	);
}

/** The owner's machines at Radius as last read, or why reading them failed (no Radius sign-in, offline). */
type Machines = { kind: "listed"; list: RadiusMachine[] } | { kind: "failed"; error: string };

/**
 * The owner's machines at Radius, each usable as an environment, and "Add machine": an enrollment code with the
 * commands that install pi-env agent on another machine.
 */
function MachinesSection({
	service,
	envs,
	machines,
	onUse,
	onOpen,
}: {
	service: Held<typeof Envs>;
	envs: readonly EnvSummary[];
	machines: Machines | undefined;
	onUse: (name: string, config: EnvConfig) => void;
	onOpen: (name: string) => void;
}) {
	const [enrollment, setEnrollment] = useState<Enrollment>();
	const [error, setError] = useState<string>();
	// Minting a code is long work with no guess to show: its pending state labels the button.
	const [, work, enrolling] = useOptimisticCall(null, keep, (reason) => setError(errorText(reason)));
	const [using, setUsing] = useState<{ server: string; name: string }>();
	const usedBy = (server: string) =>
		envs.find((env) => env.config.type === "radius" && env.config.server === server)?.name;
	const taken = (name: string) => envs.some((env) => env.name === name);
	const enroll = () => {
		setError(undefined);
		work(null, async () => setEnrollment(await service.enroll({}, BACKGROUND_CONTEXT)));
	};
	return (
		<div className="list">
			<span className="label">Your machines</span>
			{machines?.kind === "failed" && (
				<p className="muted small">Radius did not list your machines: {machines.error}</p>
			)}
			{machines?.kind === "listed" && !machines.list.length && <p className="empty-note">No machines yet.</p>}
			{(machines?.kind === "listed" ? machines.list : []).map((machine) => {
				const env = usedBy(machine.server);
				return (
					<div key={machine.server} className="stack">
						<div className="guest-row">
							<span>
								<strong>{machine.name ?? machine.server}</strong>{" "}
								<small className="muted">
									{machine.status} · seen {new Date(machine.lastSeenAt).toLocaleString()}
								</small>
							</span>
							{env ? (
								<button type="button" className="text-action" onClick={() => onOpen(env)}>
									As {env}
								</button>
							) : (
								<button
									type="button"
									className="text-action"
									onClick={() => setUsing({ server: machine.server, name: envNameFor(machine.name) })}
								>
									Use
								</button>
							)}
						</div>
						{using?.server === machine.server && (
							<form
								className="inline-form"
								onSubmit={(event) => {
									event.preventDefault();
									if (taken(using.name.trim())) return;
									onUse(using.name.trim(), { type: "radius", server: machine.server });
									setUsing(undefined);
								}}
							>
								<input
									className="input mono"
									aria-label="Environment name"
									value={using.name}
									onChange={(event) => setUsing({ ...using, name: event.target.value })}
									{...NO_AUTOCORRECT}
								/>
								<button
									type="submit"
									className="button"
									disabled={!ENV_NAME.test(using.name.trim()) || taken(using.name.trim())}
								>
									Add
								</button>
								<button type="button" className="text-action" onClick={() => setUsing(undefined)}>
									Cancel
								</button>
							</form>
						)}
						{using?.server === machine.server && taken(using.name.trim()) && (
							<p className="muted small" role="alert">
								An environment named {using.name.trim()} exists; choose another name.
							</p>
						)}
					</div>
				);
			})}
			{enrollment ? (
				<div className="stack env-enrollment">
					<p className="muted small">
						Run one of these on the machine; it installs pi-env agent as a service and enrolls it with Radius. The
						code works once, until {new Date(enrollment.expiresAt).toLocaleTimeString()}.
					</p>
					<span className="label">Linux, macOS, Termux</span>
					<textarea className="input mono" rows={3} readOnly value={enrollment.install.sh} />
					<CopyButton text={enrollment.install.sh} label="Copy command" />
					<span className="label">Windows (PowerShell)</span>
					<textarea className="input mono" rows={3} readOnly value={enrollment.install.ps1} />
					<CopyButton text={enrollment.install.ps1} label="Copy command" />
					<p className="muted small">
						The machine shows up here once its agent connected; reopen this sheet to list it.
					</p>
				</div>
			) : (
				<button type="button" className="row-button" disabled={enrolling} onClick={enroll}>
					<span>
						<PlusIcon size={14} /> {enrolling ? "Getting a code…" : "Add machine"}
					</span>
				</button>
			)}
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * "Install permanently through Radius" on a tested SSH environment: installs pi-env agent there as a service, then,
 * once the owner confirms, makes the environment a Radius machine under the same name, keeping its shell settings. An
 * agent that may not keep running (no service, or systemd without lingering) is offered only once Radius lists it
 * online; the installer's notes say what to do meanwhile. Installing again re-enrolls the same machine.
 */
function InstallSection({
	service,
	name,
	config,
	blocked,
	machines,
	onCheck,
	onSwitch,
}: {
	service: Held<typeof Envs>;
	name: string;
	config: SshEnvConfig;
	blocked: boolean;
	machines: readonly RadiusMachine[] | undefined;
	onCheck: () => Promise<unknown>;
	onSwitch: (config: EnvConfig) => void;
}) {
	const [installed, setInstalled] = useState<Installed>();
	const [error, setError] = useState<string>();
	// Installing and checking are long work with no guess to show: their pending state labels the buttons.
	const [, work, working] = useOptimisticCall(null, keep, (reason) => setError(errorText(reason)));
	const install = () => {
		setError(undefined);
		work(null, async () => setInstalled(await service.install({ name }, BACKGROUND_CONTEXT)));
	};
	const ready = installed !== undefined && installedReady(installed, machines);
	return (
		<div className="stack env-install">
			<span className="label">Permanent</span>
			{installed ? (
				<>
					<p className="small">
						pi-env agent runs on {name} ({installed.service === "none" ? "not as a service" : installed.service}
						{installed.linger === false ? ", stops when you log out" : ""}), enrolled with Radius as{" "}
						<span className="mono">{installed.server}</span>.
					</p>
					{installed.notes.map((note) => (
						<p key={note} className="small mono env-install-note">
							{note}
						</p>
					))}
					{ready ? (
						<p className="muted small">
							Reach {name} through Radius from now on? Sessions keep working there; SSH is no longer used.
						</p>
					) : (
						<p className="muted small">
							Start the agent as the notes say; {name} can be reached through Radius once it is connected.
						</p>
					)}
					<div className="inline-form">
						{ready ? (
							<button
								type="button"
								className="button primary"
								onClick={() =>
									onSwitch({
										type: "radius",
										server: installed.server,
										...(config.shellPath === undefined ? {} : { shellPath: config.shellPath }),
										...(config.loginShell ? { loginShell: true } : {}),
										...(config.shellEnv === undefined ? {} : { shellEnv: config.shellEnv }),
									})
								}
							>
								Use through Radius
							</button>
						) : (
							<button type="button" className="button" disabled={working} onClick={() => work(null, onCheck)}>
								{working ? "Checking…" : "Check connection"}
							</button>
						)}
						<button type="button" className="text-action" onClick={() => setInstalled(undefined)}>
							Keep SSH
						</button>
					</div>
				</>
			) : blocked ? (
				<p className="muted small">Sandboxes run on {name} over SSH; it stays an SSH environment.</p>
			) : (
				<>
					<p className="muted small">
						Install pi-env agent on {name} as a service enrolled with Radius: the machine is then reachable
						without SSH, from wherever this server runs.
					</p>
					<button type="button" className="button" disabled={working} onClick={install}>
						{working ? "Installing…" : "Install permanently through Radius"}
					</button>
				</>
			)}
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/** The reducer of long work without a guess: the value stays as it is until the work's state arrives. */
const keep = (value: null): null => value;

/** The host folders a sandbox sees; a new one is entered in place. */
function FoldersField({
	host,
	mounts,
	onChange,
}: {
	host: string;
	mounts: SandboxMount[];
	onChange: (mounts: SandboxMount[]) => void;
}) {
	const press = upperFirst(pressVerb(usePointerKind()));
	const [adding, setAdding] = useState<{ host: string; guest: string; readonly: boolean }>();
	const ready = adding !== undefined && adding.host.trim() !== "" && adding.guest.trim() !== "";
	const add = () => {
		if (!adding || !ready) return;
		onChange([
			...mounts,
			{ host: adding.host.trim(), guest: adding.guest.trim(), ...(adding.readonly ? { readonly: true } : {}) },
		]);
		setAdding(undefined);
	};
	// Enter adds the folder instead of submitting (saving) the whole form.
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		add();
	};
	return (
		<div className="stack sandbox-folders">
			<span className="label">Folders from {host || "the host"}</span>
			{!mounts.length && !adding && <p className="muted small">None: the VM sees only its own files.</p>}
			{mounts.map((mount, index) => (
				<div className="sandbox-folder" key={mount.guest}>
					<span className="mono small">
						{mount.host} → {mount.guest}
					</span>
					<button
						type="button"
						className="text-action"
						title={
							mount.readonly ? `Read-only: ${press} to allow writes` : `Writable: ${press} to make read-only`
						}
						onClick={() =>
							onChange(
								mounts.map((each, at) =>
									at === index
										? { host: each.host, guest: each.guest, ...(each.readonly ? {} : { readonly: true }) }
										: each,
								),
							)
						}
					>
						{mount.readonly ? "ro" : "rw"}
					</button>
					<button
						type="button"
						className="text-action"
						aria-label={`Remove ${mount.guest}`}
						onClick={() => onChange(mounts.filter((_, at) => at !== index))}
					>
						✕
					</button>
				</div>
			))}
			{adding ? (
				<div className="stack">
					<div className="env-row">
						<label className="field">
							<span className="label">Folder on {host || "the host"}</span>
							<input
								className="input mono"
								value={adding.host}
								onChange={(event) => setAdding({ ...adding, host: event.target.value })}
								onKeyDown={onKeyDown}
								placeholder="~/project"
								{...NO_AUTOCORRECT}
							/>
						</label>
						<label className="field">
							<span className="label">Path in the sandbox</span>
							<input
								className="input mono"
								value={adding.guest}
								onChange={(event) => setAdding({ ...adding, guest: event.target.value })}
								onKeyDown={onKeyDown}
								placeholder="/workspace"
								{...NO_AUTOCORRECT}
							/>
						</label>
					</div>
					<label className="check">
						<input
							type="checkbox"
							checked={adding.readonly}
							onChange={(event) => setAdding({ ...adding, readonly: event.target.checked })}
						/>
						Read-only
					</label>
					<div className="inline-form">
						<button type="button" className="button" disabled={!ready} onClick={add}>
							Add folder
						</button>
						<button type="button" className="text-action" onClick={() => setAdding(undefined)}>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="text-action"
					onClick={() => setAdding({ host: "", guest: "", readonly: false })}
				>
					+ Add folder
				</button>
			)}
		</div>
	);
}

function SandboxFields({
	draft,
	existing,
	hosts,
	update,
}: {
	draft: SandboxDraft;
	existing: boolean;
	hosts: string[];
	update: (patch: Partial<SandboxDraft>) => void;
}) {
	return (
		<>
			{!existing && <NameField value={draft.name} placeholder="box1" onChange={(name) => update({ name })} />}
			<label className="field">
				<span className="label">Runs on</span>
				<select
					className="input"
					value={draft.host}
					onChange={(event) => update({ host: event.target.value })}
					required
				>
					{!hosts.includes(draft.host) && <option value="">Choose an SSH environment</option>}
					{hosts.map((host) => (
						<option key={host} value={host}>
							{host}
						</option>
					))}
				</select>
			</label>
			<label className="field">
				<span className="label">Image (optional)</span>
				<input
					className="input mono"
					value={draft.image}
					onChange={(event) => update({ image: event.target.value })}
					placeholder="alpine-base:latest"
					{...NO_AUTOCORRECT}
				/>
			</label>
			<FoldersField host={draft.host} mounts={draft.mounts} onChange={(mounts) => update({ mounts })} />
			<label className="field">
				<span className="label">Allowed hosts (one per line)</span>
				<textarea
					className="input mono"
					rows={3}
					value={draft.allowHosts}
					onChange={(event) => update({ allowHosts: event.target.value })}
					placeholder={"github.com\n*.npmjs.org"}
					{...NO_AUTOCORRECT}
				/>
				<span className="muted small">All other HTTP(S) is refused with 403. No other protocols.</span>
			</label>
			<div className="env-row">
				<label className="field">
					<span className="label">CPUs</span>
					<input
						className="input mono"
						value={draft.cpus}
						onChange={(event) => update({ cpus: event.target.value })}
						inputMode="numeric"
						placeholder="2"
					/>
				</label>
				<label className="field">
					<span className="label">Memory (MB)</span>
					<input
						className="input mono"
						value={draft.memoryMb}
						onChange={(event) => update({ memoryMb: event.target.value })}
						inputMode="numeric"
						placeholder="1024"
					/>
				</label>
				<label className="field">
					<span className="label">Disk (GB)</span>
					<input
						className="input mono"
						value={draft.diskGb}
						onChange={(event) => update({ diskGb: event.target.value })}
						inputMode="numeric"
						placeholder={String(DEFAULT_DISK_GB)}
					/>
				</label>
			</div>
			<span className="muted small">
				The VM's own disk keeps what is installed in it across restarts. It can only grow; Reset disk starts over.
			</span>
		</>
	);
}

/** A VM state dot and word, for list rows. */
function VmLabel({ vm, tested }: { vm: VmState | undefined; tested: boolean }) {
	const text =
		vm === undefined ? (tested ? "…" : "not tested") : vm.state === "stopped" && !tested ? "not tested" : vm.state;
	return (
		<>
			<span className={`vm-dot ${vm?.state ?? ""}`} />
			{text}
		</>
	);
}

/** A sandbox's VM on its detail screen. */
function VmStatus({ vm, host }: { vm: VmState | undefined; host: string }) {
	if (!vm) return <p className="notice">Reading the VM's state on {host}…</p>;
	if (vm.state === "unknown") return <p className="notice error">VM state unknown: {vm.error}</p>;
	if (vm.state === "stopped")
		return (
			<div className="notice env-test">
				<p>
					<strong>Stopped</strong> · on {host}
				</p>
			</div>
		);
	return (
		<div className="notice env-test">
			<p>
				<strong>Running</strong> · up {uptime(vm.startedAt)} · on {host}
			</p>
			<p className="muted small">
				{plural(vm.cpus, "CPU")} · {vm.memoryMb} MB
			</p>
			{!vm.current && <p className="small">⚠ Changes apply when the VM next starts.</p>}
		</div>
	);
}

/** The sessions using an environment (archived ones too), each opening its session. */
function UsersList({ users, onOpen }: { users: readonly EnvUser[]; onOpen: (user: EnvUser) => void }) {
	return (
		<div className="list env-users">
			<span className="label">Used by {plural(users.length, "session")}</span>
			{users.map((user) => (
				<button type="button" key={user.id} className="row-button" onClick={() => onOpen(user)}>
					<span>{user.title || "Untitled"}</span>
					{user.archived && <small className="row-value">archived</small>}
					<ChevronIcon />
				</button>
			))}
		</div>
	);
}

function SandboxRow({
	env,
	vm,
	indented,
	onOpen,
}: {
	env: EnvSummary;
	vm: VmState | undefined;
	indented: boolean;
	onOpen: () => void;
}) {
	return (
		<button type="button" className={`row-button ${indented ? "env-sandbox" : ""}`} onClick={onOpen}>
			<span>
				<LockIcon /> <strong>{env.name}</strong>
			</span>
			<small className="row-value">
				<VmLabel vm={vm} tested={env.test !== undefined} /> · {plural(env.sessions, "session")}
			</small>
			<ChevronIcon />
		</button>
	);
}

/** The route's locator is the edited environment; an empty locator creates one. Form edits are not steps. */
export function EnvsPanel({ env: screen, onClose }: { env?: string; onClose: () => void }) {
	const service = useObject(Envs, {});
	const loadError = useReadable(service?.failure);
	const nav = useNavigation();
	const [editing, setEditing] = useState<Editing>();
	const [test, setTest] = useState<EnvTest>();
	const [vms, setVms] = useState<Record<string, VmState>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	// Saves and deletions show in the list at once; a refused one rolls back with its error.
	const [envs, edit] = useOptimisticCall(useReadable(service?.envs), applyEnv, (reason) =>
		setError(errorText(reason)),
	);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [machines, setMachines] = useState<Machines>();
	const readMachines = () =>
		service?.machines({}, BACKGROUND_CONTEXT).then(
			(list): Machines => ({ kind: "listed", list }),
			(reason: unknown): Machines => ({ kind: "failed", error: errorText(reason) }),
		);
	// Read from Radius once per opened sheet (and on "Check connection"); a machine enrolled meanwhile shows when the
	// sheet opens again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reads once per service; readMachines is recreated each render.
	useEffect(() => {
		let current = true;
		void readMachines()?.then((read) => {
			if (current) setMachines(read);
		});
		return () => {
			current = false;
		};
	}, [service]);
	const filled = useRef<string | null | undefined>(null);
	useEffect(() => {
		if (filled.current === screen) return;
		if (screen === undefined) {
			filled.current = screen;
			setEditing(undefined);
			return;
		}
		const host = screen.startsWith(NEW_SANDBOX) ? screen.slice(NEW_SANDBOX.length) : undefined;
		const env = envs?.find((entry) => entry.name === screen);
		if (screen !== "" && host === undefined && !env) return;
		filled.current = screen;
		setEditing(
			env
				? editingOf(env)
				: host !== undefined
					? { kind: "gondolin", draft: sandboxDraftOf("", { type: "gondolin", host }), existing: false }
					: { kind: "ssh", draft: EMPTY, existing: false },
		);
		setTest(env?.test);
		setError(undefined);
		setConfirmDelete(false);
	}, [screen, envs]);
	const sandboxNames = (envs ?? [])
		.flatMap((entry) => (entry.config.type === "gondolin" ? [entry.name] : []))
		.join(" ");
	const readVm = (name: string) =>
		service?.sandboxStatus({ name }, BACKGROUND_CONTEXT).then(
			(status): VmState => status,
			(reason: unknown): VmState => ({ state: "unknown", error: errorText(reason) }),
		);
	// VM states are read again on every screen (best effort): the list never waits for them.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reads again when the screen or the sandboxes change; readVm is recreated each render.
	useEffect(() => {
		let current = true;
		for (const name of sandboxNames.split(" ").filter(Boolean))
			void readVm(name)?.then((vm) => {
				if (current) setVms((states) => ({ ...states, [name]: vm }));
			});
		return () => {
			current = false;
		};
	}, [service, sandboxNames, screen]);
	const setVm = (name: string, vm: VmState) => setVms((states) => ({ ...states, [name]: vm }));
	const toScreen = (name: string | undefined, how: "push" | "close" = "push") =>
		void nav[how]({
			...nav.route,
			layers: [
				...nav.route.layers.slice(0, -1),
				{ kind: "sheet", name: "envs", ...(name === undefined ? {} : { locator: name }) },
			],
		});
	const run = async (operation: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await operation();
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setBusy(false);
		}
	};
	const sshEnvs = (envs ?? []).filter((entry) => entry.config.type === "ssh");
	const radiusEnvs = (envs ?? []).filter((entry) => entry.config.type === "radius");
	const sandboxesOn = (host: string) =>
		(envs ?? []).filter((entry) => entry.config.type === "gondolin" && entry.config.host === host);
	const name = editing?.draft.name.trim() ?? "";
	const updateSsh = (patch: Partial<SshDraft>) =>
		setEditing((current) =>
			current?.kind === "ssh" ? { ...current, draft: { ...current.draft, ...patch } } : current,
		);
	const updateSandbox = (patch: Partial<SandboxDraft>) =>
		setEditing((current) =>
			current?.kind === "gondolin" ? { ...current, draft: { ...current.draft, ...patch } } : current,
		);
	const updateRadius = (patch: Partial<RadiusDraft>) =>
		setEditing((current) =>
			current?.kind === "radius" ? { ...current, draft: { ...current.draft, ...patch } } : current,
		);
	const testNow = async () => {
		if (!service) return;
		setTest(await service.test({ name }, BACKGROUND_CONTEXT));
		// A sandbox's test starts its VM.
		if (editing?.kind === "gondolin") void readVm(name)?.then((vm) => setVm(name, vm));
	};
	/** Saves the form: the environment is listed (and the form an existing one's) at once; the save's call. */
	const save = (): Promise<unknown> | undefined => {
		if (!service || !editing) return undefined;
		setError(undefined);
		let config: EnvConfig;
		try {
			config =
				editing.kind === "ssh"
					? sshConfigOf(editing.draft)
					: editing.kind === "radius"
						? radiusConfigOf(editing.draft)
						: sandboxConfigOf(editing.draft);
		} catch (reason) {
			setError(errorText(reason));
			return undefined;
		}
		const saving = service.save({ name, config }, BACKGROUND_CONTEXT);
		edit({ kind: "save", name, config }, () => saving);
		setEditing((current) => current && { ...current, existing: true });
		if (!editing.existing) {
			filled.current = name;
			void nav.replace({
				...nav.route,
				layers: [...nav.route.layers.slice(0, -1), { kind: "sheet", name: "envs", locator: name }],
			});
		}
		// A running VM keeps its configuration until it restarts: read whether it is still current.
		if (editing.kind === "gondolin")
			void saving.then(
				() => readVm(name)?.then((vm) => setVm(name, vm)),
				() => {},
			);
		return saving;
	};
	/**
	 * Saves, then tests (an SSH env) or starts the VM (a sandbox; a running one restarts, applying the change): long
	 * work, so the form shows "Working…" until it answers.
	 */
	const saveAnd = (then: "test" | "start" | "restart") =>
		void run(async () => {
			const saving = save();
			if (!saving || !service) return;
			await saving;
			if (then === "test") return testNow();
			if (then === "restart") await service.sandboxStop({ name }, BACKGROUND_CONTEXT);
			setVm(name, await service.sandboxStart({ name }, BACKGROUND_CONTEXT));
		});
	if (editing) {
		const { existing } = editing;
		const saved = envs?.find((env) => env.name === name);
		const sessions = saved?.sessions ?? 0;
		const sandbox = editing.kind === "gondolin";
		const hostedSandboxes = editing.kind === "ssh" && existing ? sandboxesOn(name) : [];
		const vm = vms[name];
		const ready = Boolean(name && (editing.kind === "radius" ? editing.draft.server : editing.draft.host.trim()));
		return (
			<Sheet
				title={
					existing ? name : sandbox ? "New sandbox" : editing.kind === "radius" ? "New machine" : "New environment"
				}
				onClose={onClose}
			>
				{editing.kind === "gondolin" && (
					<>
						{existing && saved?.config.type === "gondolin" && service && (
							<div className="stack sandbox-status">
								<VmStatus vm={vm} host={saved.config.host} />
								<div className="inline-form">
									{vm?.state === "running" ? (
										<>
											<button
												type="button"
												className="button"
												disabled={busy}
												onClick={() =>
													void run(async () =>
														setVm(name, await service.sandboxStop({ name }, BACKGROUND_CONTEXT)),
													)
												}
											>
												Stop
											</button>
											<button
												type="button"
												className="button"
												disabled={busy}
												onClick={() =>
													void run(async () => {
														setVm(name, await service.sandboxStop({ name }, BACKGROUND_CONTEXT));
														setVm(name, await service.sandboxStart({ name }, BACKGROUND_CONTEXT));
													})
												}
											>
												Restart
											</button>
										</>
									) : (
										<button
											type="button"
											className="button"
											disabled={busy}
											onClick={() =>
												void run(async () =>
													setVm(name, await service.sandboxStart({ name }, BACKGROUND_CONTEXT)),
												)
											}
										>
											Start
										</button>
									)}
									<button type="button" className="button" disabled={busy} onClick={() => void run(testNow)}>
										{busy ? "Working…" : "Test"}
									</button>
								</div>
								{confirmReset ? (
									<div className="stack">
										<span className="small">
											Reset {name}'s disk? Everything installed in the VM is removed, and it starts from the
											guest image again. Shared folders are not touched.
										</span>
										<div className="inline-form">
											<button
												type="button"
												className="text-action danger"
												disabled={busy}
												onClick={() =>
													void run(async () => {
														setConfirmReset(false);
														setVm(name, await service.sandboxResetDisk({ name }, BACKGROUND_CONTEXT));
													})
												}
											>
												Reset disk
											</button>
											<button type="button" className="text-action" onClick={() => setConfirmReset(false)}>
												Cancel
											</button>
										</div>
									</div>
								) : (
									<button
										type="button"
										className="text-action danger"
										disabled={busy}
										onClick={() => setConfirmReset(true)}
									>
										Reset disk
									</button>
								)}
							</div>
						)}
						<p className="muted small sandbox-intro">
							A VM on {editing.draft.host || "an SSH environment"}. It sees only the folders listed here and
							reaches only the allowed hosts; sessions working in it cannot leave it.
						</p>
					</>
				)}
				<form
					className="stack env-form"
					onSubmit={(event) => {
						event.preventDefault();
						// A refused save shows through its rollback.
						void save()?.catch(() => {});
					}}
				>
					{editing.kind === "ssh" ? (
						<SshFields draft={editing.draft} existing={existing} update={updateSsh} />
					) : editing.kind === "radius" ? (
						<RadiusFields
							draft={editing.draft}
							existing={existing}
							machine={
								machines?.kind === "listed"
									? machines.list.find((machine) => machine.server === editing.draft.server)
									: undefined
							}
							update={updateRadius}
						/>
					) : (
						<SandboxFields
							draft={editing.draft}
							existing={existing}
							hosts={sshEnvs.map((env) => env.name)}
							update={updateSandbox}
						/>
					)}
					<div className="inline-form">
						<button type="submit" className="button" disabled={busy || !ready}>
							Save
						</button>
						<button
							type="button"
							className="button primary"
							disabled={busy || !ready}
							onClick={() => saveAnd(sandbox ? (vm?.state === "running" ? "restart" : "start") : "test")}
						>
							{busy
								? "Working…"
								: sandbox
									? vm?.state === "running"
										? "Save and restart"
										: "Save and start"
									: "Save and test"}
						</button>
					</div>
				</form>
				{editing.kind === "gondolin" && existing && (
					<SecretsSection sandbox={name} onChanged={() => void readVm(name)?.then((vm) => setVm(name, vm))} />
				)}
				{editing.kind === "ssh" && service && (
					<KeySection service={service} name={name} onKey={(identityFile) => updateSsh({ identityFile })} />
				)}
				{editing.kind === "ssh" && existing && service && saved?.config.type === "ssh" && saved.test?.ok && (
					<InstallSection
						service={service}
						name={name}
						config={saved.config}
						blocked={hostedSandboxes.length > 0}
						machines={machines?.kind === "listed" ? machines.list : undefined}
						onCheck={async () => {
							const read = await readMachines();
							if (read) setMachines(read);
						}}
						onSwitch={(config) => {
							setError(undefined);
							edit({ kind: "save", name, config }, () => service.save({ name, config }, BACKGROUND_CONTEXT));
							setEditing(editingOf({ ...saved, config }));
							setTest(undefined);
						}}
					/>
				)}
				{test && service && (
					<TestResult
						test={test}
						busy={busy}
						onAccept={(lines) =>
							void run(async () => {
								await service.acceptHostKey({ name, lines }, BACKGROUND_CONTEXT);
								await testNow();
							})
						}
						onForget={() =>
							void run(async () => {
								await service.forgetHostKey({ name }, BACKGROUND_CONTEXT);
								await testNow();
							})
						}
					/>
				)}
				{error && (
					<p className="notice error" role="alert">
						{error}
					</p>
				)}
				{editing.kind === "ssh" && existing && (
					<div className="list">
						<span className="label">Sandboxes on {name}</span>
						{hostedSandboxes.map((entry) => (
							<SandboxRow
								key={entry.name}
								env={entry}
								vm={vms[entry.name]}
								indented={false}
								onOpen={() => toScreen(entry.name)}
							/>
						))}
						<button type="button" className="row-button" onClick={() => toScreen(`${NEW_SANDBOX}${name}`)}>
							<span>
								<PlusIcon size={14} /> Add sandbox
							</span>
						</button>
					</div>
				)}
				<div className="list">
					{existing && sessions > 0 && (
						<UsersList
							users={saved?.users ?? []}
							onOpen={(user) => void nav.push(conversationRoute(nav.route, user.id, user.main))}
						/>
					)}
					{existing &&
						(hostedSandboxes.length > 0 ? (
							<p className="muted small">Sandboxes run on it; delete them before the environment.</p>
						) : confirmDelete ? (
							<div className="stack">
								<span className="small">
									Delete "{name}"
									{sessions > 0
										? ` anyway? ${plural(sessions, "session")} keep their history, but their tools refuse to run until you move them to another location.`
										: "?"}
									{sandbox ? " Its disk, with everything installed in the VM, is removed too." : ""}
								</span>
								<div className="inline-form">
									<button
										type="button"
										className="text-action danger"
										onClick={() => {
											if (!service) return;
											setError(undefined);
											edit({ kind: "delete", name }, () =>
												service.delete({ name, force: sessions > 0 }, BACKGROUND_CONTEXT),
											);
											toScreen(undefined, "close");
										}}
									>
										Delete
									</button>
									<button type="button" className="text-action" onClick={() => setConfirmDelete(false)}>
										Cancel
									</button>
								</div>
							</div>
						) : (
							<button type="button" className="text-action danger" onClick={() => setConfirmDelete(true)}>
								{sandbox ? "Delete sandbox" : "Delete environment"}
								{sessions > 0 ? " anyway" : ""}
							</button>
						))}
					<button type="button" className="text-action" onClick={() => toScreen(undefined, "close")}>
						← All environments
					</button>
				</div>
			</Sheet>
		);
	}
	return (
		<Sheet title="Environments" onClose={onClose}>
			<p className="muted small">
				Sessions in a remote environment run their tools on that machine, over SSH or, for a machine running pi-env
				agent, through Radius; the agent, its history and your credentials stay here. SSH keys come from your SSH
				agent or identity file; passwords are not supported. Sandboxes are VMs on an SSH environment that sessions
				working in them cannot leave.
			</p>
			{(error || loadError) && (
				<p className="notice error" role="alert">
					{error || loadError}
				</p>
			)}
			<div className="list">
				{sshEnvs.map((entry) => (
					<div key={entry.name} className="env-group">
						<button type="button" className="row-button" onClick={() => toScreen(entry.name)}>
							<span>
								<strong>{entry.name}</strong>{" "}
								<span className="muted mono small">{entry.config.type === "ssh" && entry.config.host}</span>
							</span>
							<small className="row-value">{testSummary(entry.test)}</small>
							<ChevronIcon />
						</button>
						{sandboxesOn(entry.name).map((sandbox) => (
							<SandboxRow
								key={sandbox.name}
								env={sandbox}
								vm={vms[sandbox.name]}
								indented
								onOpen={() => toScreen(sandbox.name)}
							/>
						))}
						{hostsSandboxes(entry) && (
							<button
								type="button"
								className="row-button env-sandbox"
								onClick={() => toScreen(`${NEW_SANDBOX}${entry.name}`)}
							>
								<span className="muted">
									<PlusIcon size={14} /> Add sandbox on {entry.name}
								</span>
							</button>
						)}
					</div>
				))}
				{radiusEnvs.map((entry) => (
					<button key={entry.name} type="button" className="row-button" onClick={() => toScreen(entry.name)}>
						<span>
							<strong>{entry.name}</strong> <span className="muted small">Radius machine</span>
						</span>
						<small className="row-value">{testSummary(entry.test)}</small>
						<ChevronIcon />
					</button>
				))}
				{envs && !envs.length && <p className="empty-note">No environments yet.</p>}
				<button type="button" className="row-button" onClick={() => toScreen("")}>
					<span>
						<PlusIcon size={14} /> Add environment
					</span>
				</button>
			</div>
			{service && (
				<MachinesSection
					service={service}
					envs={envs ?? []}
					machines={machines}
					onOpen={(name) => toScreen(name)}
					onUse={(name, config) => {
						setError(undefined);
						edit({ kind: "save", name, config }, () =>
							service.save({ name, config, create: true }, BACKGROUND_CONTEXT),
						);
					}}
				/>
			)}
			<div className="list">
				<span className="label">This device</span>
				<SlotList prefix="envs-actions" />
			</div>
		</Sheet>
	);
}
