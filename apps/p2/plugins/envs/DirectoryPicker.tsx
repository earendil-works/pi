// The location picker: one sheet to choose a machine (this device, an SSH environment, a sandbox) and a folder on it.
// Per machine it offers the folders sessions worked in most recently, then a folder browser; every step is a history
// entry. Used for a new session's location, moving a session, and a new project's folder.
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	CheckIcon,
	NavDisclosureIcon,
	NavEditIcon,
	NavFolderIcon,
	NavLockIcon,
	QueryCache,
	Sheet,
	shortPath,
	useNavigation,
	useObject,
	useReadable,
	useSheet,
} from "@p2/app/v1/web";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { type DirectoryListing, Envs } from "./contract.ts";
import type { EnvConfig } from "./schema.ts";

/** The picker at the location its view passes (`env`, `value`): the session's, or the new session's. */
export const DIRECTORY_PICKER = { kind: "sheet", name: "cwd" } as const;

/** The picker at `path` on `env`; `name` is its layer's, for a picker another screen than the chat opens. */
export function directoryPickerLayer(env: string | null, path: string, name: string = DIRECTORY_PICKER.name) {
	return { kind: "sheet" as const, name, locator: JSON.stringify({ env, path }) };
}

function locationLabel(env: string | null, cwd: string): string {
	return env ? `${env}:${shortPath(cwd)}` : shortPath(cwd);
}

/** Listings by environment and requested path: Back and revisits show them at once, then refresh. */
const listings = new QueryCache<DirectoryListing>();
const listingKey = (env: string | null, path: string) => `${env ?? ""}\0${path}`;

function name(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** A session's location and when it was last active: what the recent folders are made of. */
export type LocationUse = { readonly env?: string | null; readonly cwd: string; readonly updatedAt: number };

export function DirectoryPicker({
	env: initialEnv,
	moving,
	value,
	sessions,
	sheet: sheetName = DIRECTORY_PICKER.name,
	title = "Location",
	onChange,
	onClose,
}: {
	/** The environment browsed: a remote env's name, or null for this device. */
	env: string | null;
	/** An existing session's environment: choosing another one moves the session there. */
	moving?: { env: string | null };
	value: string;
	/** The owner's sessions, archived ones included: each machine's recent folders are theirs (none without). */
	sessions?: readonly LocationUse[] | undefined;
	/** The name of its layer (`directoryPickerLayer`'s `name`): the chat's pickers use the default. */
	sheet?: string;
	title?: string;
	onChange: (env: string | null, value: string) => void;
	onClose: () => void;
}) {
	const service = useObject(Envs, {});
	const envs = useReadable(service?.envs);
	// The environments' connections start now, as in Pi Mobile: the first listing need not wait for ssh.
	useEffect(() => {
		void service?.warm(BACKGROUND_CONTEXT).catch(() => {});
	}, [service]);
	const recentOf = useRecentFolders(sessions);
	const nav = useNavigation();
	const sheet = useSheet(sheetName);
	let directory = value;
	let env = initialEnv;
	if (sheet?.locator) {
		try {
			const locator = JSON.parse(sheet.locator) as { path?: unknown; env?: unknown };
			if (typeof locator.path === "string" && (typeof locator.env === "string" || locator.env === null)) {
				directory = locator.path;
				env = locator.env;
			}
		} catch {
			/* Old routes start at the session's current location. */
		}
	}
	/** The listing shown, with the environment it belongs to: another environment's folders are never shown. */
	const [listing, setListing] = useState<DirectoryListing & { env: string | null }>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	/** The path being typed, while the path line is a text field. */
	const [typing, setTyping] = useState<string>();
	/** The folder whose move out of the sandbox waits for the owner's confirmation. */
	const [leaving, setLeaving] = useState<string>();

	const request = (path: string, where: string | null) => () =>
		service!.listDirectory({ path, ...(where === null ? {} : { env: where }) }, BACKGROUND_CONTEXT);
	// Every folder change, and a change of machine, is a step: Back returns to the previous one. The listing is
	// requested with the tap, not after the step has rendered.
	const browse = (path: string, machine = env) => {
		setTyping(undefined);
		setLeaving(undefined);
		const route = nav.route;
		const top = route.layers.at(-1);
		if (top?.kind !== "sheet" || top.name !== sheetName) return;
		listings.prefetch(listingKey(machine, path), request(path, machine));
		if (path === directory && machine === env) load(path);
		else
			void nav.push({
				...route,
				layers: [...route.layers.slice(0, -1), directoryPickerLayer(machine, path, sheetName)],
			});
	};
	/** Only the latest folder's answer is shown: an earlier, slower one must not replace it. */
	const latest = useRef("");
	const load = (path: string) => {
		const key = listingKey(env, path);
		latest.current = key;
		setLoading(true);
		setError(undefined);
		const cached = listings.get(key);
		if (cached) setListing({ ...cached, env });
		else setListing((current) => (current?.env === env ? current : undefined));
		if (!service) return;
		void listings
			.fetch(key, request(path, env))
			.then((next) => {
				if (latest.current !== key) return;
				if (
					!next ||
					typeof next.path !== "string" ||
					(next.parent !== null && typeof next.parent !== "string") ||
					!Array.isArray(next.directories) ||
					!next.directories.every((entry) => typeof entry === "string")
				)
					throw new Error("The folder listing was interrupted.");
				setListing({ ...next, env });
			})
			.catch((caught: Error) => {
				if (latest.current !== key) return;
				setListing(undefined);
				setError(caught.message);
			})
			.finally(() => {
				if (latest.current === key) setLoading(false);
			});
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: lists again when the folder or machine changes; load is recreated each render.
	useEffect(() => load(directory), [directory, env, service]);
	const sandboxHost = (machine: string | null) => {
		const config = envs?.find((entry) => entry.name === machine)?.config;
		return config?.type === "gondolin" ? config.host : undefined;
	};
	const machines = useMemo(() => machinesOf(envs, env), [envs, env]);
	const moves = moving !== undefined && moving.env !== env;
	const sandbox = sandboxHost(env) !== undefined;
	// Leaving a sandbox is confirmed: outside every sandbox its tools run unconfined, in another one they get its
	// folders and network access.
	const leaves = moves && sandboxHost(moving.env) !== undefined;
	const pick = (path: string) => {
		if (env === initialEnv && path === value) onClose();
		else if (leaves) setLeaving(path);
		else onChange(env, path);
	};
	const recent = recentOf(env);
	const here = listing?.path ?? directory;
	const verb = moves ? "Move session to" : "Use";

	return (
		<Sheet title={title} onClose={onClose} className="location-sheet">
			{machines.length > 1 && (
				<div className="location-machines">
					{machines.map((machine) => (
						<button
							type="button"
							key={machine.name ?? ""}
							aria-pressed={machine.name === env}
							className="location-machine"
							title={machine.title}
							onClick={() => machine.name !== env && browse("~", machine.name)}
						>
							{machine.sandbox && <NavLockIcon size={14} aria-label="Sandbox" />}
							{machine.label}
						</button>
					))}
				</div>
			)}
			{sandbox && (
				<p className="location-note">
					{moving
						? `Tools of this session run in the ${env} VM and can't leave it. Only you can move the session out.`
						: `Tools of a session here run in the ${env} VM and can't leave it.`}
				</p>
			)}
			{recent.length > 0 && (
				<section className="location-section" aria-label="Recent folders">
					<h3 className="location-heading">Recent</h3>
					<ul className="location-rows">
						{recent.map((path) => {
							const current = env === initialEnv && path === value;
							return (
								<li key={path} className={`location-row ${current ? "current" : ""}`}>
									<button
										type="button"
										className="location-link"
										title={`${verb} ${locationLabel(env, path)}`}
										onClick={() => pick(path)}
									>
										<NavFolderIcon size={16} />
										{/* Cut at its start when long: the folder's own name stays. */}
										<span className="location-name location-name-tail">
											<span>{shortPath(path)}</span>
										</span>
										{current && <CheckIcon />}
									</button>
									<button
										type="button"
										className="location-control"
										aria-label={`Browse ${shortPath(path)}`}
										onClick={() => browse(path)}
									>
										<NavDisclosureIcon size={16} className="location-chevron" aria-hidden="true" />
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			)}
			<section className="location-section location-browse" aria-label="Folders">
				<div className="location-path">
					{typing === undefined ? (
						<>
							<Crumbs path={here} onBrowse={browse} />
							{loading && listing && <span className="spinner location-spinner" aria-hidden="true" />}
							<button
								type="button"
								className="location-control"
								aria-label="Type a path"
								title="Type a path"
								onClick={() => setTyping(here)}
							>
								<NavEditIcon size={16} />
							</button>
						</>
					) : (
						<PathInput
							value={typing}
							onChange={setTyping}
							onSubmit={(path) => browse(path)}
							onCancel={() => setTyping(undefined)}
						/>
					)}
				</div>
				{error && (
					<p className="location-error" role="alert">
						{error}{" "}
						<button type="button" className="text-action" onClick={() => load(directory)}>
							Retry
						</button>
					</p>
				)}
				{loading && !listing && !error && (
					<p className="location-loading">
						<span className="spinner" />
						{env ? `Connecting to ${env}…` : "Loading…"}
					</p>
				)}
				{listing && (
					<ul className={`location-rows ${loading ? "busy" : ""}`} aria-busy={loading}>
						{listing.parent && (
							<li className="location-row">
								<button
									type="button"
									className="location-link"
									onClick={() => browse(listing.parent ?? listing.path)}
								>
									<NavFolderIcon size={16} />
									<span className="location-name">..</span>
								</button>
							</li>
						)}
						{listing.directories.map((path) => (
							<li key={path} className="location-row">
								<button type="button" className="location-link" onClick={() => browse(path)}>
									<NavFolderIcon size={16} />
									<span className="location-name">{name(path)}</span>
									<NavDisclosureIcon size={16} className="location-chevron" aria-hidden="true" />
								</button>
							</li>
						))}
						{!listing.directories.length && <li className="location-empty">No subfolders</li>}
						{listing.truncated && <li className="location-empty">Showing the first 1,000 folders</li>}
					</ul>
				)}
			</section>
			<footer className="location-foot">
				{leaving !== undefined ? (
					<div className="location-leave" role="alert">
						<p>
							<strong>Leave sandbox {moving?.env}?</strong>
						</p>
						<p>
							{sandbox
								? `Moving to ${locationLabel(env, leaving)} gives this session's tools sandbox ${env}'s folders and allowed hosts instead.`
								: `Moving to ${locationLabel(env, leaving)} lets this session's tools run directly on ${env ?? "this device"}, with its full network access and files.`}
						</p>
						<p className="location-note">Files written in the sandbox stay in its folders.</p>
						<div className="inline-form">
							<button type="button" className="button danger" onClick={() => onChange(env, leaving)}>
								Move out
							</button>
							<button type="button" className="button" onClick={() => setLeaving(undefined)}>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<>
						{moves && (
							<p className="location-note">
								Tools will run {env === null ? "on this device" : `on ${env}`}. The history stays; files are not
								copied.
							</p>
						)}
						<button
							type="button"
							className="button primary block location-use"
							title={`${verb} ${locationLabel(env, here)}`}
							disabled={loading || !listing}
							onClick={() => listing && pick(listing.path)}
						>
							<span className="location-name">
								{verb} {locationLabel(env, here)}
							</span>
						</button>
					</>
				)}
			</footer>
		</Sheet>
	);
}

/** How many recent folders a machine offers. */
const RECENT = 5;

/**
 * The folders sessions worked in, per machine (null: this device), the most recently active first, archived sessions
 * included: what the owner used last, without storing anything of its own.
 */
function useRecentFolders(sessions: readonly LocationUse[] | undefined): (env: string | null) => readonly string[] {
	const byMachine = useMemo(() => {
		const folders = new Map<string, string[]>();
		for (const session of (sessions ?? []).toSorted((a, b) => b.updatedAt - a.updatedAt)) {
			const machine = session.env ?? "";
			const list = folders.get(machine) ?? [];
			if (list.length < RECENT && !list.includes(session.cwd)) list.push(session.cwd);
			folders.set(machine, list);
		}
		return folders;
	}, [sessions]);
	return (env) => byMachine.get(env ?? "") ?? [];
}

type Machine = {
	readonly name: string | null;
	readonly label: string;
	readonly title: string;
	readonly sandbox: boolean;
};

/** This device, then the SSH environments, then the sandboxes; `env` too when it is not configured (any more). */
function machinesOf(
	envs: readonly { readonly name: string; readonly config: EnvConfig }[] | undefined,
	env: string | null,
): readonly Machine[] {
	const machines: Machine[] = [{ name: null, label: "This device", title: "This device", sandbox: false }];
	for (const entry of envs ?? [])
		if (entry.config.type === "ssh")
			machines.push({ name: entry.name, label: entry.name, title: `${entry.name} (SSH)`, sandbox: false });
	for (const entry of envs ?? [])
		if (entry.config.type === "gondolin")
			machines.push({
				name: entry.name,
				label: entry.name,
				title: `${entry.name}: sandbox on ${entry.config.host}`,
				sandbox: true,
			});
	if (env !== null && !machines.some((machine) => machine.name === env))
		machines.push({ name: env, label: env, title: `${env} (not configured)`, sandbox: false });
	return machines;
}

/**
 * The path as steps to tap: the home folder as `~`, else the root, then each folder below it; the last one is where
 * the browser is.
 */
function Crumbs({ path, onBrowse }: { path: string; onBrowse: (path: string) => void }) {
	const steps = crumbsOf(path);
	return (
		<nav className="location-crumbs" aria-label="Path" title={path}>
			{steps.map((step, index) =>
				index === steps.length - 1 ? (
					<span key={step.path} className="location-crumb" aria-current="location">
						{step.label}
					</span>
				) : (
					<span key={step.path} className="location-crumb-step">
						<button type="button" className="location-crumb" onClick={() => onBrowse(step.path)}>
							{step.label}
						</button>
						{/* The root's own name is the separator already. */}
						{step.label !== "/" && (
							<span className="location-crumb-gap" aria-hidden="true">
								/
							</span>
						)}
					</span>
				),
			)}
		</nav>
	);
}

/** `path`'s steps: `~` (the conventional home folders `shortPath` knows), `/`, a Windows drive, then its folders. */
function crumbsOf(path: string): readonly { label: string; path: string }[] {
	const separator = /^[A-Za-z]:\\|^\\\\/.test(path) ? "\\" : "/";
	const short = shortPath(path);
	const drive = /^[A-Za-z]:/.exec(path)?.[0];
	const first =
		short !== path && short.startsWith("~")
			? { label: "~", path: path.slice(0, path.length - short.length + 1), rest: short.slice(1) }
			: drive
				? { label: drive, path: `${drive}${separator}`, rest: path.slice(drive.length) }
				: path.startsWith("/")
					? { label: "/", path: "/", rest: path }
					: { label: path, path, rest: "" };
	const steps = [{ label: first.label, path: first.path }];
	let at = first.path;
	for (const part of first.rest.split(/[\\/]/).filter(Boolean)) {
		at = at.endsWith(separator) ? `${at}${part}` : `${at}${separator}${part}`;
		steps.push({ label: part, path: at });
	}
	return steps;
}

/** The path line as a text field: Enter browses there, Escape goes back to the steps. */
function PathInput({
	value,
	onChange,
	onSubmit,
	onCancel,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: (path: string) => void;
	onCancel: () => void;
}) {
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (value.trim()) onSubmit(value.trim());
	};
	// Escape leaves the field, not the sheet (the sheet closes on an Escape nobody handled).
	const key = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		onCancel();
	};
	return (
		<form className="location-type" onSubmit={submit}>
			<input
				className="location-input"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={key}
				aria-label="Directory"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				enterKeyHint="go"
				// biome-ignore lint/a11y/noAutofocus: the field appears because the owner asked to type a path.
				autoFocus
			/>
		</form>
	);
}
