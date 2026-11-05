// Sharing in the browser: the share sheet (owner), and the guest's presence while its page is open.

import { BACKGROUND_CONTEXT, contribute, defineFacet } from "@p2/app/v1";
import {
	closeLayers,
	copyText,
	errorText,
	readValue,
	Sheet,
	Slots,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { GuestPresence, type ShareMode, Sharing } from "./contract.ts";

const LABEL: Record<ShareMode, string> = { view: "Read-only", full: "Read/write" };

/**
 * Two links per session (read-only; read/write: send and Stop), the people it is shared with by email, and the guests
 * connected now. People are offered only while the brain is connected to Radius (`peopleUrl`): they open the session
 * there, signed in with that email, in any organization.
 */
function ShareSheet({ session, onClose }: { session: string; onClose: () => void }) {
	const sharing = useObject(Sharing, { session });
	const links = useReadable(sharing?.links);
	const guests = useReadable(sharing?.guests);
	const people = useReadable(sharing?.people);
	const peopleUrl = useReadable(sharing?.peopleUrl);
	const remoteEnv = useReadable(sharing?.env);
	const [copied, setCopied] = useState<ShareMode | "address">();
	const [email, setEmail] = useState("");
	const [personMode, setPersonMode] = useState<ShareMode>("view");
	const [confirming, setConfirming] = useState<
		{ reset: ShareMode } | { remove: string } | { remote: true } | { share: string }
	>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(undefined), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	const copy = async (mode: ShareMode, remoteConfirmed = false) => {
		if (!sharing) return;
		setError(undefined);
		try {
			let url = links?.find((link) => link.mode === mode)?.url;
			if (url === undefined && mode === "full" && remoteEnv && !remoteConfirmed) {
				setConfirming({ remote: true });
				return;
			}
			if (url === undefined) {
				await sharing.link({ mode, ...(remoteConfirmed ? { remoteConfirmed } : {}) }, BACKGROUND_CONTEXT);
				// The answer follows its state: the new link is in `links` when the call resolves.
				url = readValue(sharing.links)?.find((link) => link.mode === mode)?.url;
			}
			if (url !== undefined && (await copyText(url))) setCopied(mode);
		} catch (reason) {
			setError(errorText(reason));
		}
	};
	/** Shares with the typed email; read/write on a remote environment is confirmed first. */
	const share = async (address: string, remoteConfirmed = false) => {
		if (!sharing) return;
		setError(undefined);
		if (personMode === "full" && remoteEnv && !remoteConfirmed) {
			setConfirming({ share: address });
			return;
		}
		try {
			await sharing.share(
				{ email: address, mode: personMode, ...(remoteConfirmed ? { remoteConfirmed } : {}) },
				BACKGROUND_CONTEXT,
			);
			setEmail("");
		} catch (reason) {
			setError(errorText(reason));
		}
	};
	const copyAddress = async () => {
		if (peopleUrl && (await copyText(peopleUrl))) setCopied("address");
	};
	const confirm = () => {
		if (!sharing || !confirming) return;
		setConfirming(undefined);
		if ("remote" in confirming) {
			void copy("full", true);
			return;
		}
		if ("share" in confirming) {
			void share(confirming.share, true);
			return;
		}
		const action =
			"reset" in confirming
				? sharing.link(
						{
							mode: confirming.reset,
							reset: true,
							...(remoteEnv && confirming.reset === "full" ? { remoteConfirmed: true } : {}),
						},
						BACKGROUND_CONTEXT,
					)
				: sharing.remove({ guestId: confirming.remove }, BACKGROUND_CONTEXT);
		action.catch((reason: unknown) => setError(errorText(reason)));
	};
	const cancel = (
		<button type="button" className="text-action" onClick={() => setConfirming(undefined)}>
			Cancel
		</button>
	);
	/** Remove, confirmed in place: for a link guest (blocked from the session) or a person (shared no more). */
	const removal = (id: string) =>
		confirming && "remove" in confirming && confirming.remove === id ? (
			<span className="inline-form">
				<button type="button" className="text-action danger" onClick={confirm}>
					Remove
				</button>
				{cancel}
			</span>
		) : (
			<button type="button" className="text-action" onClick={() => setConfirming({ remove: id })}>
				Remove
			</button>
		);
	return (
		<Sheet title="Share" onClose={onClose}>
			<p className="muted small">
				Anyone with a link can join this session and its subagents under a name they choose. Read/write lets them
				make the agent run commands and change files on{" "}
				{remoteEnv ? `the remote environment "${remoteEnv}"` : "this host"}.
			</p>
			<div className="list">
				{(["view", "full"] as const).map((mode) => {
					const exists = links?.some((link) => link.mode === mode) ?? false;
					return (
						<div className="share-row" key={mode}>
							<span>{LABEL[mode]}</span>
							{mode === "full" && confirming && "remote" in confirming ? (
								<>
									<span className="muted small">
										Guests can run commands on "{remoteEnv}". Create the link?
									</span>
									<button type="button" className="text-action danger" onClick={confirm}>
										Create
									</button>
									{cancel}
								</>
							) : confirming && "reset" in confirming && confirming.reset === mode ? (
								<>
									<span className="muted small">New link, disconnect its guests?</span>
									<button type="button" className="text-action danger" onClick={confirm}>
										Reset
									</button>
									{cancel}
								</>
							) : (
								<>
									{exists && (
										<button
											type="button"
											className="text-action"
											onClick={() => setConfirming({ reset: mode })}
										>
											Reset
										</button>
									)}
									<button
										type="button"
										className={`button ${copied === mode ? "done" : ""}`}
										disabled={links === undefined}
										onClick={() => void copy(mode)}
									>
										{copied === mode ? "Copied" : "Copy link"}
									</button>
								</>
							)}
						</div>
					);
				})}
			</div>
			{peopleUrl && (
				<div className="list">
					<span className="label">People</span>
					<p className="muted small">
						Share with someone's email; they open this session in Radius, signed in with that address.
					</p>
					<form
						className="inline-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (email.trim()) void share(email.trim());
						}}
					>
						<input
							className="input"
							type="email"
							aria-label="Email"
							placeholder="Email"
							autoComplete="off"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
						<select
							className="input"
							aria-label="Access"
							value={personMode}
							onChange={(event) => setPersonMode(event.target.value as ShareMode)}
						>
							<option value="view">{LABEL.view}</option>
							<option value="full">{LABEL.full}</option>
						</select>
						<button type="submit" className="button" disabled={!email.trim()}>
							Share
						</button>
					</form>
					{confirming && "share" in confirming && (
						<div className="share-row">
							<span className="muted small">
								{confirming.share} can run commands on "{remoteEnv}". Share read/write?
							</span>
							<button type="button" className="text-action danger" onClick={confirm}>
								Share
							</button>
							{cancel}
						</div>
					)}
					{people?.map((person) => (
						<div className="guest-row" key={person.id}>
							<span>
								{person.name}{" "}
								<small className="muted">· {person.mode === "full" ? "read/write" : "read-only"}</small>
							</span>
							{removal(person.id)}
						</div>
					))}
					{people && people.length > 0 && (
						<div className="share-row">
							<span className="muted small">Send them this session's address in Radius.</span>
							<button
								type="button"
								className={`button ${copied === "address" ? "done" : ""}`}
								onClick={() => void copyAddress()}
							>
								{copied === "address" ? "Copied" : "Copy address"}
							</button>
						</div>
					)}
				</div>
			)}
			<div className="list">
				<span className="label">Connected</span>
				{guests && !guests.length && <p className="empty-note">No guests connected.</p>}
				{guests?.map((guest) => (
					<div className="guest-row" key={guest.id}>
						<span>
							{guest.name}{" "}
							<small className="muted">· {guest.mode === "full" ? "read/write" : "read-only"}</small>
						</span>
						{removal(guest.id)}
					</div>
				))}
			</div>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</Sheet>
	);
}

/** The top bar's share button (owner only). */
function ShareButton() {
	const { session } = useRoute();
	const owner = useOwner();
	const open = useSheet("share") !== undefined;
	if (session === undefined || !owner) return null;
	return open ? <ShareSheet session={session} onClose={closeLayers} /> : null;
}

export default defineFacet((host) => {
	contribute(host, "p2.sharing-web", (self) => {
		// A guest counts as connected while its page holds this (the owner's variant does nothing).
		self.get(GuestPresence, {});
		self.contribute(Slots, { "session-actions": ShareButton });
	});
});
