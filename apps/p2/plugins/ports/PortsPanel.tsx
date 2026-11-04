import { BACKGROUND_CONTEXT, liveIn } from "@p2/app/v1";
import { CopyButton, Sheet, useObject, useReadable } from "@p2/app/v1/web";
import { useState } from "react";
import { Ports } from "./contract.ts";

/** Every forward is visible to the owner. Making one public requires a second explicit tap. */
export function PortsPanel({ onClose }: { onClose: () => void }) {
	const service = liveIn(useObject(Ports, {}), "owner");
	const forwards = useReadable(service?.forwards);
	const origin = useReadable(service?.radiusOrigin);
	const [port, setPort] = useState("");
	const [name, setName] = useState("");
	const [removing, setRemoving] = useState<string>();
	const [publishing, setPublishing] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await action();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const onDevice = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
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
					const setPublic = (open: boolean) =>
						void run(async () => {
							await service?.setPublic({ id: forward.id, public: open }, BACKGROUND_CONTEXT);
							setPublishing(undefined);
						});
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
												disabled={busy}
												onClick={() =>
													void run(() => service!.remove({ id: forward.id }, BACKGROUND_CONTEXT))
												}
											>
												Remove
											</button>
											<button type="button" className="text-action" onClick={() => setRemoving(undefined)}>
												Cancel
											</button>
										</>
									) : (
										<>
											<button type="button" className="text-action" onClick={() => setRemoving(forward.id)}>
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
									<button
										type="button"
										className="text-action danger"
										disabled={busy}
										onClick={() => setPublic(true)}
									>
										Make public
									</button>
									<button type="button" className="text-action" onClick={() => setPublishing(undefined)}>
										Cancel
									</button>
								</div>
							) : (
								<label className="check forward-public">
									<input
										type="checkbox"
										checked={forward.public ?? false}
										disabled={busy}
										onChange={(event) =>
											event.target.checked ? setPublishing(forward.id) : setPublic(false)
										}
									/>
									Public: no sign-in
								</label>
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
					void run(async () => {
						await service?.add(
							{ port: Number(port.trim()), ...(name.trim() ? { name: name.trim() } : {}) },
							BACKGROUND_CONTEXT,
						);
						setPort("");
						setName("");
					});
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
				<button type="submit" className="button primary" disabled={!service || busy || !/^\d+$/.test(port.trim())}>
					Add
				</button>
			</form>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</Sheet>
	);
}
