import type { Static } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, type HeldIn, liveIn } from "@p2/app/v1";
import { CopyButton, errorText, Sheet, Switch, useObject, useOptimisticCall, useReadable } from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { Envs } from "../envs/contract.ts";
import { type ForwardSchema, Ports } from "./contract.ts";

type Forward = Static<typeof ForwardSchema>;

/** A change of the list while its call is in flight. */
type PortGuess =
	| { readonly kind: "add"; readonly key: string; readonly port: number; readonly name: string | undefined }
	| { readonly kind: "remove"; readonly id: string }
	| { readonly kind: "public"; readonly id: string; readonly open: boolean };

/**
 * The list with a change applied. An added forward's id and addresses are the server's: until it answers, the row
 * shows the port and name only (no Open, no link).
 */
function applyPort(forwards: Forward[] | undefined, guess: PortGuess): Forward[] | undefined {
	if (!forwards) return forwards;
	if (guess.kind === "add")
		return [...forwards, { id: guess.key, port: guess.port, ...(guess.name ? { name: guess.name } : {}) }];
	if (guess.kind === "remove") return forwards.filter((forward) => forward.id !== guess.id);
	return forwards.map((forward) =>
		forward.id === guess.id
			? { ...forward, public: guess.open, ...(guess.open ? {} : { publicUrl: undefined }) }
			: forward,
	);
}

/**
 * Every forward is visible to the owner. Making one public requires a second explicit tap. Adding, removing and the
 * public switch show at once; a refused one rolls back with its error.
 */
export function PortsPanel({ onClose }: { onClose: () => void }) {
	const service = liveIn(useObject(Ports, {}), "owner");
	const origin = useReadable(service?.radiusOrigin);
	const [port, setPort] = useState("");
	const [name, setName] = useState("");
	const [removing, setRemoving] = useState<string>();
	const [publishing, setPublishing] = useState<string>();
	const [error, setError] = useState<string>();
	const [forwards, change] = useOptimisticCall(useReadable(service?.forwards), applyPort, (reason) =>
		setError(errorText(reason)),
	);
	const run = (guess: PortGuess, call: () => Promise<unknown>) => {
		setError(undefined);
		change(guess, call);
	};
	const onDevice = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
	const machines = (useReadable(useObject(Envs, {})?.envs) ?? []).flatMap((env) =>
		env.config.type === "radius" ? [env.name] : [],
	);
	return (
		<Sheet title="Ports" onClose={onClose}>
			<p className="muted small">
				Open web servers running on this device, such as a dev server, from your other devices. Each port gets its
				own address through Radius, which signs you in to it. A public port has a second address that anyone can
				open without signing in.
			</p>
			{forwards && !origin && (
				<p className="muted small">
					Links appear once this server has been opened through Radius (
					<span className="mono">npm run radius:login</span>, then Pi in Radius).
				</p>
			)}
			<div className="list">
				{forwards?.map((forward) => {
					const url = forward.url ?? (onDevice ? `http://localhost:${forward.port}/` : undefined);
					const pending = forward.id.startsWith("adding-");
					const setPublic = (open: boolean) => {
						setPublishing(undefined);
						if (service)
							run({ kind: "public", id: forward.id, open }, () =>
								service.setPublic({ id: forward.id, public: open }, BACKGROUND_CONTEXT),
							);
					};
					return (
						<div className="forward" key={forward.id}>
							<div className="guest-row forward-row">
								<span>
									{forward.name ?? `Port ${forward.port}`}{" "}
									<small className="muted mono">localhost:{forward.port}</small>
									{forward.session && (
										<small className="muted"> · by {forward.sessionTitle ?? "another session"}</small>
									)}
								</span>
								<span className="inline-form">
									{removing === forward.id ? (
										<>
											<button
												type="button"
												className="text-action danger"
												onClick={() => {
													setRemoving(undefined);
													if (service)
														run({ kind: "remove", id: forward.id }, () =>
															service.remove({ id: forward.id }, BACKGROUND_CONTEXT),
														);
												}}
											>
												Remove
											</button>
											<button type="button" className="text-action" onClick={() => setRemoving(undefined)}>
												Cancel
											</button>
										</>
									) : (
										<>
											<button
												type="button"
												className="text-action"
												disabled={pending}
												onClick={() => setRemoving(forward.id)}
											>
												Remove
											</button>
											{forward.url && <CopyButton text={forward.url} />}
											{url && (
												<a className="button" href={url} target="_blank" rel="noopener noreferrer">
													Open
												</a>
											)}
										</>
									)}
								</span>
							</div>
							{publishing === forward.id ? (
								<div className="inline-form forward-public">
									<span className="small">
										Anyone with the link can open localhost:{forward.port} without signing in.
									</span>
									<button type="button" className="text-action danger" onClick={() => setPublic(true)}>
										Make public
									</button>
									<button type="button" className="text-action" onClick={() => setPublishing(undefined)}>
										Cancel
									</button>
								</div>
							) : (
								<div className="forward-public">
									<Switch
										label="Public: no sign-in"
										checked={forward.public ?? false}
										disabled={pending}
										onChange={(checked) => (checked ? setPublishing(forward.id) : setPublic(false))}
									/>
								</div>
							)}
							{forward.publicUrl && (
								<div className="inline-form forward-public">
									<span className="mono small forward-link">{forward.publicUrl}</span>
									<CopyButton text={forward.publicUrl} />
								</div>
							)}
						</div>
					);
				})}
				{forwards && !forwards.length && <p className="empty-note">No ports forwarded.</p>}
			</div>
			<form
				className="inline-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!service) return;
					const added = { port: Number(port.trim()), ...(name.trim() ? { name: name.trim() } : {}) };
					run({ kind: "add", key: `adding-${crypto.randomUUID()}`, port: added.port, name: added.name }, () =>
						service.add(added, BACKGROUND_CONTEXT),
					);
					setPort("");
					setName("");
				}}
			>
				<input
					className="input mono forward-port"
					value={port}
					onChange={(event) => setPort(event.target.value)}
					inputMode="numeric"
					placeholder="5173"
					aria-label="Port"
					required
				/>
				<input
					className="input"
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={40}
					placeholder="Name (optional)"
					aria-label="Name"
				/>
				<button type="submit" className="button primary" disabled={!service || !/^\d+$/.test(port.trim())}>
					Add
				</button>
			</form>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
			{service && machines.map((env) => <MachinePorts key={env} service={service} env={env} />)}
		</Sheet>
	);
}

/** A machine's forwards as last read from its agent, or why reading them failed (offline, not signed in). */
type MachineState =
	| { kind: "loading" }
	| { kind: "listed"; forwards: Forward[]; origin: string | null }
	| { kind: "failed"; error: string };

/**
 * The forwards of a machine running pi-env agent (a Radius machine): its agent keeps them, so they are read from it
 * when the sheet opens and again after each change. Public needs the same second tap as on this device.
 */
function MachinePorts({ service, env }: { service: HeldIn<typeof Ports, "owner">; env: string }) {
	const [state, setState] = useState<MachineState>({ kind: "loading" });
	const [port, setPort] = useState("");
	const [name, setName] = useState("");
	const [publishing, setPublishing] = useState<string>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let current = true;
		void service.machine({ env }, BACKGROUND_CONTEXT).then(
			({ forwards, origin }) => current && setState({ kind: "listed", forwards, origin }),
			(reason: unknown) => current && setState({ kind: "failed", error: errorText(reason) }),
		);
		return () => {
			current = false;
		};
	}, [service, env]);
	// Changes show at once; each call answers with the machine's list after it, which replaces the guess as it settles.
	const [forwards, change] = useOptimisticCall(
		state.kind === "listed" ? state.forwards : undefined,
		applyPort,
		(reason) => setError(errorText(reason)),
	);
	const run = (guess: PortGuess, call: () => Promise<{ forwards: Forward[]; origin: string | null }>) => {
		setError(undefined);
		change(guess, async () => {
			const { forwards: next, origin } = await call();
			setState({ kind: "listed", forwards: next, origin });
		});
	};
	return (
		<div className="list">
			<span className="label">On {env} (Radius machine)</span>
			{state.kind === "loading" && <p className="muted small">Reading its forwards…</p>}
			{state.kind === "failed" && <p className="muted small">Its forwards could not be read: {state.error}</p>}
			{state.kind === "listed" && !state.origin && (
				<p className="muted small">Links appear once the machine's agent knows its address at Radius.</p>
			)}
			{forwards?.map((forward) => {
				const pending = forward.id.startsWith("adding-");
				return (
					<div className="forward" key={forward.id}>
						<div className="guest-row forward-row">
							<span>
								{forward.name ?? `Port ${forward.port}`}{" "}
								<small className="muted mono">
									{env}:{forward.port}
								</small>
								{forward.session && (
									<small className="muted"> · by {forward.sessionTitle ?? "another session"}</small>
								)}
							</span>
							<span className="inline-form">
								<button
									type="button"
									className="text-action"
									disabled={pending}
									onClick={() =>
										run({ kind: "remove", id: forward.id }, () =>
											service.machineRemove({ env, id: forward.id }, BACKGROUND_CONTEXT),
										)
									}
								>
									Remove
								</button>
								{forward.url && <CopyButton text={forward.url} />}
								{forward.url && (
									<a className="button" href={forward.url} target="_blank" rel="noopener noreferrer">
										Open
									</a>
								)}
							</span>
						</div>
						{publishing === forward.id ? (
							<div className="inline-form forward-public">
								<span className="small">
									Anyone with the link can open {env}:{forward.port} without signing in.
								</span>
								<button
									type="button"
									className="text-action danger"
									onClick={() => {
										setPublishing(undefined);
										run({ kind: "public", id: forward.id, open: true }, () =>
											service.machineSetPublic({ env, id: forward.id, public: true }, BACKGROUND_CONTEXT),
										);
									}}
								>
									Make public
								</button>
								<button type="button" className="text-action" onClick={() => setPublishing(undefined)}>
									Cancel
								</button>
							</div>
						) : (
							<div className="forward-public">
								<Switch
									label="Public: no sign-in"
									checked={forward.public ?? false}
									disabled={pending}
									onChange={(checked) =>
										checked
											? setPublishing(forward.id)
											: run({ kind: "public", id: forward.id, open: false }, () =>
													service.machineSetPublic(
														{ env, id: forward.id, public: false },
														BACKGROUND_CONTEXT,
													),
												)
									}
								/>
							</div>
						)}
						{forward.publicUrl && (
							<div className="inline-form forward-public">
								<span className="mono small forward-link">{forward.publicUrl}</span>
								<CopyButton text={forward.publicUrl} />
							</div>
						)}
					</div>
				);
			})}
			{forwards && !forwards.length && <p className="empty-note">No ports forwarded.</p>}
			<form
				className="inline-form"
				onSubmit={(event) => {
					event.preventDefault();
					const added = { env, port: Number(port.trim()), ...(name.trim() ? { name: name.trim() } : {}) };
					run({ kind: "add", key: `adding-${crypto.randomUUID()}`, port: added.port, name: added.name }, () =>
						service.machineAdd(added, BACKGROUND_CONTEXT),
					);
					setPort("");
					setName("");
				}}
			>
				<input
					className="input mono forward-port"
					value={port}
					onChange={(event) => setPort(event.target.value)}
					inputMode="numeric"
					placeholder="5173"
					aria-label={`Port on ${env}`}
					required
				/>
				<input
					className="input"
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={40}
					placeholder="Name (optional)"
					aria-label={`Name on ${env}`}
				/>
				<button
					type="submit"
					className="button primary"
					disabled={state.kind !== "listed" || !/^\d+$/.test(port.trim())}
				>
					Add
				</button>
			</form>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
