import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	ChevronIcon,
	CopyButton,
	errorText,
	PlusIcon,
	Sheet,
	SlotList,
	useNavigation,
	useObject,
	useOptimisticCall,
	useReadable,
} from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import { type EnvSummary, Envs, type EnvTest } from "./contract.ts";
import { ENV_NAME, type EnvConfig } from "./schema.ts";

type Draft = {
	name: string;
	host: string;
	user: string;
	port: string;
	identityFile: string;
	shellPath: string;
	loginShell: boolean;
	shellEnv: string;
};
const EMPTY: Draft = {
	name: "",
	host: "",
	user: "",
	port: "",
	identityFile: "",
	shellPath: "",
	loginShell: false,
	shellEnv: "",
};
function draftOf(env: EnvSummary): Draft {
	return {
		name: env.name,
		host: env.config.host,
		user: env.config.user ?? "",
		port: env.config.port === undefined ? "" : String(env.config.port),
		identityFile: env.config.identityFile ?? "",
		shellPath: env.config.shellPath ?? "",
		loginShell: env.config.loginShell ?? false,
		shellEnv: Object.entries(env.config.shellEnv ?? {})
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
	};
}
function configOf(draft: Draft): EnvConfig {
	const shellEnv: Record<string, string> = {};
	for (const line of draft.shellEnv.split("\n")) {
		if (!line.trim()) continue;
		const separator = line.indexOf("=");
		if (separator < 1) throw new Error(`Environment variables are KEY=value lines: ${line}`);
		shellEnv[line.slice(0, separator).trim()] = line.slice(separator + 1);
	}
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

/** The route's locator is the edited environment; an empty locator creates one. Form edits are not steps. */
export function EnvsPanel({ env: screen, onClose }: { env?: string; onClose: () => void }) {
	const service = useObject(Envs, {});
	const loadError = useReadable(service?.failure);
	const nav = useNavigation();
	const [editing, setEditing] = useState<{ draft: Draft; existing: boolean }>();
	const [test, setTest] = useState<EnvTest>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	// Saves and deletions show in the list at once; a refused one rolls back with its error.
	const [envs, edit] = useOptimisticCall(useReadable(service?.envs), applyEnv, (reason) =>
		setError(errorText(reason)),
	);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const filled = useRef<string | null | undefined>(null);
	useEffect(() => {
		if (filled.current === screen) return;
		if (screen === undefined) {
			filled.current = screen;
			setEditing(undefined);
			return;
		}
		const env = envs?.find((entry) => entry.name === screen);
		if (screen !== "" && !env) return;
		filled.current = screen;
		setEditing(env ? { draft: draftOf(env), existing: true } : { draft: EMPTY, existing: false });
		setTest(env?.test);
		setError(undefined);
		setConfirmDelete(false);
	}, [screen, envs]);
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
	const name = editing?.draft.name.trim() ?? "";
	const update = (patch: Partial<Draft>) =>
		setEditing((current) => current && { ...current, draft: { ...current.draft, ...patch } });
	/** Saves the form: the environment is listed (and the form an existing one's) at once; the save's call. */
	const save = (): Promise<unknown> | undefined => {
		if (!service || !editing) return undefined;
		setError(undefined);
		let config: EnvConfig;
		try {
			config = configOf(editing.draft);
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
		return saving;
	};
	/** Saves, then tests: long work, so the form shows "Working…" until the test answers. */
	const saveAndTest = () =>
		void run(async () => {
			const saving = save();
			if (!saving || !service) return;
			await saving;
			setTest(await service.test({ name }, BACKGROUND_CONTEXT));
		});
	if (editing) {
		const { draft, existing } = editing;
		const sessions = envs?.find((env) => env.name === name)?.sessions ?? 0;
		return (
			<Sheet title={existing ? name : "New environment"} onClose={onClose}>
				<form
					className="stack env-form"
					onSubmit={(event) => {
						event.preventDefault();
						// A refused save shows through its rollback.
						void save()?.catch(() => {});
					}}
				>
					{!existing && (
						<label className="field">
							<span className="label">Name</span>
							<input
								className="input mono"
								value={draft.name}
								onChange={(event) => update({ name: event.target.value })}
								placeholder="gpu"
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								required
							/>
						</label>
					)}
					<label className="field">
						<span className="label">Host (name or ~/.ssh/config alias)</span>
						<input
							className="input mono"
							value={draft.host}
							onChange={(event) => update({ host: event.target.value })}
							placeholder="gpu-box"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
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
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
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
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
					</label>
					<label className="field">
						<span className="label">Shell for commands (default: bash, else sh)</span>
						<input
							className="input mono"
							value={draft.shellPath}
							onChange={(event) => update({ shellPath: event.target.value })}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
					</label>
					<label className="check">
						<input
							type="checkbox"
							checked={draft.loginShell}
							onChange={(event) => update({ loginShell: event.target.checked })}
						/>
						Start through the login shell (loads ~/.profile, e.g. Homebrew's PATH on macOS)
					</label>
					<label className="field">
						<span className="label">Environment variables (KEY=value per line)</span>
						<textarea
							className="input mono"
							rows={2}
							value={draft.shellEnv}
							onChange={(event) => update({ shellEnv: event.target.value })}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
					</label>
					<div className="inline-form">
						<button type="submit" className="button" disabled={busy || !name || !draft.host.trim()}>
							Save
						</button>
						<button
							type="button"
							className="button primary"
							disabled={busy || !name || !draft.host.trim()}
							onClick={saveAndTest}
						>
							{busy ? "Working…" : "Save and test"}
						</button>
					</div>
				</form>
				{service && <KeySection service={service} name={name} onKey={(identityFile) => update({ identityFile })} />}
				{test && service && (
					<TestResult
						test={test}
						busy={busy}
						onAccept={(lines) =>
							void run(async () => {
								await service.acceptHostKey({ name, lines }, BACKGROUND_CONTEXT);
								setTest(await service.test({ name }, BACKGROUND_CONTEXT));
							})
						}
						onForget={() =>
							void run(async () => {
								await service.forgetHostKey({ name }, BACKGROUND_CONTEXT);
								setTest(await service.test({ name }, BACKGROUND_CONTEXT));
							})
						}
					/>
				)}
				{error && (
					<p className="notice error" role="alert">
						{error}
					</p>
				)}
				<div className="list">
					{existing &&
						(sessions > 0 ? (
							<p className="muted small">
								Used by {sessions} session{sessions === 1 ? "" : "s"} (archived ones included); it cannot be
								deleted while they exist.
							</p>
						) : confirmDelete ? (
							<div className="inline-form">
								<span className="small">Delete "{name}"?</span>
								<button
									type="button"
									className="text-action danger"
									onClick={() => {
										if (!service) return;
										setError(undefined);
										edit({ kind: "delete", name }, () => service.delete({ name }, BACKGROUND_CONTEXT));
										toScreen(undefined, "close");
									}}
								>
									Delete
								</button>
								<button type="button" className="text-action" onClick={() => setConfirmDelete(false)}>
									Cancel
								</button>
							</div>
						) : (
							<button type="button" className="text-action danger" onClick={() => setConfirmDelete(true)}>
								Delete environment
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
				Sessions in a remote environment run their tools on that machine over SSH; the agent, its history and your
				credentials stay here. Keys come from your SSH agent or identity file; passwords are not supported.
			</p>
			{(error || loadError) && (
				<p className="notice error" role="alert">
					{error || loadError}
				</p>
			)}
			<div className="list">
				{envs?.map((entry) => (
					<button type="button" key={entry.name} className="row-button" onClick={() => toScreen(entry.name)}>
						<span>
							<strong>{entry.name}</strong> <span className="muted mono small">{entry.config.host}</span>
						</span>
						<small className="row-value">
							{entry.test === undefined
								? "Not tested"
								: entry.test.ok
									? `${entry.test.platform} · ${entry.test.latencyMs} ms`
									: "Failed"}
						</small>
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
			<div className="list">
				<span className="label">This device</span>
				<SlotList prefix="envs-actions" />
			</div>
		</Sheet>
	);
}
