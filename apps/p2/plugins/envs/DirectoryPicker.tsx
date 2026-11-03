import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	ChevronIcon,
	FolderIcon,
	QueryCache,
	Sheet,
	shortPath,
	useNavigation,
	useObject,
	useReadable,
	useSheet,
} from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import { type DirectoryListing, Envs } from "./contract.ts";

export function directoryPickerLayer(env: string | null, path: string) {
	return { kind: "sheet" as const, name: "cwd", locator: JSON.stringify({ env, path }) };
}
function locationLabel(env: string | null, cwd: string): string {
	return env ? `${env}:${cwd}` : shortPath(cwd);
}

/** Listings by environment and requested path: Back and revisits show them at once, then refresh. */
const listings = new QueryCache<DirectoryListing>();
const listingKey = (env: string | null, path: string) => `${env ?? ""}\0${path}`;

function name(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function DirectoryPicker({
	env: initialEnv,
	moving,
	value,
	recent = () => [],
	onChange,
	onClose,
}: {
	/** The environment browsed: a remote env's name, or null for this device. */
	env: string | null;
	/** An existing session's environment: choosing another one moves the session there. */
	moving?: { env: string | null };
	value: string;
	recent?: (env: string | null) => string[];
	onChange: (env: string | null, value: string) => void;
	onClose: () => void;
}) {
	const service = useObject(Envs, {});
	const envs = useReadable(service?.envs) ?? [];
	// The environments' connections start now, as in Pi Mobile: the first listing need not wait for ssh.
	useEffect(() => {
		void service?.warm(BACKGROUND_CONTEXT).catch(() => {});
	}, [service]);
	const nav = useNavigation();
	const sheet = useSheet("cwd");
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
	const [input, setInput] = useState(value);
	/** The listing shown, with the environment it belongs to: another environment's folders are never shown. */
	const [listing, setListing] = useState<DirectoryListing & { env: string | null }>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();

	const shown = directory ?? value;
	const request = (path: string, where: string | null) => () =>
		service!.listDirectory({ path, ...(where === null ? {} : { env: where }) }, BACKGROUND_CONTEXT);
	// Every folder change, and a change of environment, is a step: Back returns to the previous one. The listing is
	// requested with the tap, not after the step has rendered.
	const browse = (path: string, environment = env) => {
		const route = nav.route;
		const top = route.layers.at(-1);
		if (top?.kind !== "sheet" || top.name !== "cwd") return;
		listings.prefetch(listingKey(environment, path), request(path, environment));
		if (path === shown && environment === env) load(path);
		else
			void nav.push({
				...route,
				layers: [...route.layers.slice(0, -1), directoryPickerLayer(environment, path)],
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
		if (cached) {
			setListing({ ...cached, env });
			setInput(cached.path);
		} else setListing((current) => (current?.env === env ? current : undefined));
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
					throw new Error("Directory listing was interrupted. Press Enter or select a folder to retry.");
				setListing({ ...next, env });
				setInput(next.path);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: lists again when the folder or environment changes; load is recreated each render.
	useEffect(() => load(shown), [shown, env, service]);
	const moves = moving !== undefined && moving.env !== env;

	return (
		<Sheet title="Working directory" onClose={onClose}>
			{/* Path and the choice stay pinned while the folder list scrolls with the sheet. */}
			<div className="sheet-sticky directory-head">
				{envs.length > 0 && (
					<select
						className="input"
						aria-label="Environment"
						value={env ?? ""}
						onChange={(event) => browse("~", event.target.value || null)}
						disabled={loading}
					>
						<option value="">This device</option>
						{envs.map((entry) => (
							<option key={entry.name} value={entry.name}>
								{entry.name} (remote)
							</option>
						))}
					</select>
				)}
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (input.trim()) browse(input.trim());
					}}
				>
					<input
						className="input mono"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						aria-label="Directory"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						disabled={loading}
					/>
				</form>
				{listing && (
					<button
						type="button"
						className="button primary block directory-use"
						disabled={loading}
						onClick={() => onChange(env, listing.path)}
					>
						{moves ? "Move session to" : "Use"} {locationLabel(env, listing.path)}
					</button>
				)}
				{moves && (
					<p className="muted small directory-note">
						Tools will run {env === null ? "on this device" : `on ${env}`}. The history stays; files are not
						copied.
					</p>
				)}
			</div>
			{error && <p className="notice error directory-error">{error}</p>}
			{loading && !listing && (
				<div className="directory-loading">
					<div className="spinner" />
					<span>{env ? `Connecting to ${env}…` : "Loading…"}</span>
				</div>
			)}
			{listing && (
				<div className={`list ${loading ? "directory-busy" : ""}`} aria-busy={loading}>
					{loading && (
						<div className="directory-loading">
							<div className="spinner" />
							<span>Loading…</span>
						</div>
					)}
					{listing.parent && (
						<button
							type="button"
							className="row-button mono"
							onClick={() => browse(listing.parent ?? listing.path)}
						>
							<span>
								<FolderIcon /> ..
							</span>
							<ChevronIcon />
						</button>
					)}
					{listing.directories.map((path) => (
						<button type="button" key={path} className="row-button mono" onClick={() => browse(path)}>
							<span>
								<FolderIcon /> {name(path)}
							</span>
							<ChevronIcon />
						</button>
					))}
					{!listing.directories.length && <p className="empty-note">No subdirectories.</p>}
					{listing.truncated && <p className="muted small">Showing the first 1,000 directories.</p>}
				</div>
			)}
			{recent(env).length > 0 && (
				<div className="list">
					<span className="label">Recent</span>
					{recent(env)
						.slice(0, 8)
						.map((path) => (
							<button type="button" key={path} className="row-button mono" onClick={() => browse(path)}>
								<span>
									<FolderIcon /> {locationLabel(env, path)}
								</span>
								<ChevronIcon />
							</button>
						))}
				</div>
			)}
		</Sheet>
	);
}
