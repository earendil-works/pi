// The MCP sheet (owners): the running servers with their status, errors and tools, restart, and signing in and out of
// HTTP servers that use OAuth. Sign in opens `/mcp/sign-in/<server>` in a new tab (it finds out where the browser runs);
// while a sign-in waits, the final redirect URL can be pasted here, for a browser that cannot reach where it returns.

import { BACKGROUND_CONTEXT, contribute, defineFacet, type HeldIn, locationText } from "@p2/app/v1";
import {
	ChevronIcon,
	closeLayers,
	errorText,
	openLayer,
	Sheet,
	Slots,
	useComposerState,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useSheet,
} from "@p2/app/v1/web";
import { useState } from "react";
import { type Instance, Mcp, type SignIn, signInLink } from "./contract.ts";

type OwnerView = HeldIn<typeof Mcp, "owner">;

/** A change of the instances while its call is in flight: a restart starts it, a sign-out leaves it signed out. */
type InstanceGuess =
	| { readonly kind: "restart"; readonly instance: string }
	| { readonly kind: "signOut"; readonly server: string };

function applyInstance(instances: readonly Instance[], guess: InstanceGuess): readonly Instance[] {
	return instances.map((instance) =>
		guess.kind === "restart"
			? instance.id === guess.instance
				? { ...instance, status: "starting", error: undefined }
				: instance
			: instance.server === guess.server && instance.auth === "oauth"
				? { ...instance, status: "sign-in" }
				: instance,
	);
}

/** What a server's entry does; each shows its effect at once and rolls back with the error in the toast. */
type Actions = {
	readonly restart: (instance: string) => void;
	readonly signOut: (server: string) => void;
	readonly cancelSignIn: (id: string) => void;
};

const STATUS: Record<Instance["status"], string> = {
	starting: "Starting",
	connected: "Connected",
	"sign-in": "Sign-in needed",
	failed: "Failed",
};

/** The sheet: configuration errors, then each server with its instances and sign-in. */
function McpSheet({ onClose }: { onClose: () => void }) {
	const view = useObject(Mcp, {}, { variant: "owner" });
	const errors = useReadable(view?.errors) ?? [];
	const { fail } = useComposerState();
	const [instances, changeInstance] = useOptimisticCall(useReadable(view?.instances) ?? [], applyInstance, fail);
	const [signIns, cancel] = useOptimisticCall(
		useReadable(view?.signIns) ?? [],
		(list, id: string) => list.filter((entry) => entry.id !== id),
		fail,
	);
	const servers = [...new Set(instances.map((instance) => instance.server))];
	const actions: Actions | undefined = view && {
		restart: (instance) =>
			changeInstance({ kind: "restart", instance }, () => view.restart({ instance }, BACKGROUND_CONTEXT)),
		signOut: (server) =>
			changeInstance({ kind: "signOut", server }, () => view.signOut({ server }, BACKGROUND_CONTEXT)),
		cancelSignIn: (id) => cancel(id, () => view.cancelSignIn({ id }, BACKGROUND_CONTEXT)),
	};
	return (
		<Sheet title="MCP servers" onClose={onClose}>
			<p className="muted small">
				Servers of <span className="mono">mcp.json</span> run while sessions use them. Sign-in credentials are
				stored on the server.
			</p>
			{errors.map((error) => (
				<p key={error} className="notice error small">
					{error}
				</p>
			))}
			{view && servers.length === 0 && <p className="empty-note">No MCP server is running.</p>}
			{view && actions && (
				<div className="list">
					{servers.map((server) => (
						<ServerEntry
							key={server}
							view={view}
							actions={actions}
							server={server}
							instances={instances.filter((instance) => instance.server === server)}
							signIn={signIns.find((entry) => entry.server === server)}
						/>
					))}
				</div>
			)}
		</Sheet>
	);
}

/** One server: its instances (status, place, tools, error, restart), and signing in or out if it uses OAuth. */
function ServerEntry({
	view,
	actions,
	server,
	instances,
	signIn,
}: {
	view: OwnerView;
	actions: Actions;
	server: string;
	instances: readonly Instance[];
	signIn: SignIn | undefined;
}) {
	const oauth = instances.some((instance) => instance.auth === "oauth");
	const needsSignIn = instances.some((instance) => instance.status === "sign-in");
	const connected = instances.some((instance) => instance.status === "connected");
	return (
		<div className="stack mcp-server">
			<strong>{server}</strong>
			{instances.map((instance) => (
				<div key={instance.id} className="stack">
					<p className="small">
						{STATUS[instance.status]}
						{instance.location && <span className="muted mono"> · {locationText(instance.location)}</span>}
						{instance.runsOn !== "host" && <span className="muted"> · on {instance.runsOn.env}</span>}
						{instance.status === "connected" && (
							<span className="muted">
								{" "}
								· {instance.tools.length} tool{instance.tools.length === 1 ? "" : "s"}
							</span>
						)}
					</p>
					{instance.error && instance.status !== "sign-in" && <p className="error small">{instance.error}</p>}
					<div className="inline-form">
						<button type="button" className="text-action" onClick={() => actions.restart(instance.id)}>
							Restart
						</button>
					</div>
				</div>
			))}
			{oauth && signIn?.status === "waiting" && (
				<PendingSignIn view={view} signIn={signIn} onCancel={() => actions.cancelSignIn(signIn.id)} />
			)}
			{oauth && signIn?.status === "failed" && (
				<div className="stack">
					<p className="error small">{signIn.error ?? "The sign-in failed."}</p>
					<button type="button" className="text-action" onClick={() => actions.cancelSignIn(signIn.id)}>
						Dismiss
					</button>
				</div>
			)}
			{oauth && (
				<div className="inline-form">
					{needsSignIn || signIn !== undefined ? (
						<a className="login-continue" href={signInLink(server)} target="_blank" rel="noreferrer">
							{signIn?.status === "waiting" ? "Sign in again" : "Sign in"}
							<ChevronIcon />
						</a>
					) : null}
					{connected && (
						<button type="button" className="text-action danger" onClick={() => actions.signOut(server)}>
							Sign out
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** A sign-in waiting for the browser: paste the final redirect URL, or cancel. */
function PendingSignIn({ view, signIn, onCancel }: { view: OwnerView; signIn: SignIn; onCancel: () => void }) {
	const [value, setValue] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<form
			className="stack"
			onSubmit={(event) => {
				event.preventDefault();
				setSending(true);
				setError(undefined);
				view
					.paste({ id: signIn.id, redirectUrl: value.trim() }, BACKGROUND_CONTEXT)
					.then(() => setValue(""))
					.catch((reason: unknown) => setError(errorText(reason)))
					.finally(() => setSending(false));
			}}
		>
			<p className="muted small">
				Waiting for the sign-in in the browser. If it ends on a page that does not load (
				{signIn.via === "loopback" ? "a 127.0.0.1 address" : "p2's address"}), copy that page's full address from
				the address bar and paste it here.
			</p>
			<input
				className="input mono"
				type="text"
				autoComplete="off"
				placeholder="Final redirect URL"
				aria-label="Final redirect URL"
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			{error && <p className="error small">{error}</p>}
			<div className="inline-form">
				<button type="submit" className="button" disabled={sending || !value.trim()}>
					Continue
				</button>
				<button type="button" className="text-action" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

/** The sidebar footer's MCP button: any authenticated owner. */
function McpButton() {
	const owner = useOwner();
	const open = useSheet("mcp") !== undefined;
	if (!owner) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "mcp" }, { fromDrawer: true })}
				title="MCP servers"
			>
				MCP
			</button>
			{open && <McpSheet onClose={closeLayers} />}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-mcp", (self) => {
		self.contribute(Slots, { "sidebar-foot:mcp": McpButton });
	});
});
