// The Providers sheet (any owner): sign in to model providers, refresh their catalogs, sign out.

import type { AuthEvent } from "@earendil-works/pi-ai";
import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet } from "@p2/app/v1";
import {
	CheckIcon,
	ChevronIcon,
	closeLayers,
	openLayer,
	SearchIcon,
	Sheet,
	Slots,
	useComposerState,
	useHost,
	useNavigation,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type LoginState, ProviderLogin } from "./contract.ts";

const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** Links from providers open only over http(s). */
function Link({ url, label }: { url: string; label: string }) {
	let safe = false;
	try {
		safe = ["http:", "https:"].includes(new URL(url).protocol);
	} catch {}
	return safe ? (
		<a className="login-continue" href={url} target="_blank" rel="noreferrer">
			{label}
			<ChevronIcon />
		</a>
	) : (
		<span>{label}</span>
	);
}

function Notice({ event }: { event: AuthEvent }): ReactNode {
	switch (event.type) {
		case "auth_url":
			return (
				<div className="login-step">
					<Link url={event.url} label="Continue in browser" />
					{event.instructions && <p className="muted small">{event.instructions}</p>}
				</div>
			);
		case "device_code":
			return (
				<div className="login-step">
					<p className="muted small">Enter this code on the verification page</p>
					<div className="code-box">{event.userCode}</div>
					{/* A provider may ask clients not to offer opening the page; its address is still needed. */}
					{event.openBrowserOnConfirm === false ? (
						<p className="muted small">{event.verificationUri}</p>
					) : (
						<Link url={event.verificationUri} label="Open verification page" />
					)}
				</div>
			);
		case "progress":
			return <p className="muted small">{event.message}</p>;
		case "info":
			return (
				<div className="login-step">
					<p>{event.message}</p>
					{event.links?.map((link) => (
						<Link key={link.url} url={link.url} label={link.label ?? "More information"} />
					))}
				</div>
			);
	}
}

function PromptForm({ state, login }: { state: LoginState; login: Held<typeof ProviderLogin> }) {
	const prompt = state.prompt;
	const [value, setValue] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	if (!prompt) return null;
	const answer = (input: string) => {
		setSending(true);
		setError(undefined);
		login
			.answer({ attemptId: state.attemptId, promptId: prompt.id, value: input }, BACKGROUND_CONTEXT)
			.then(() => setValue(""))
			.catch((reason: unknown) => setError(errorText(reason)))
			.finally(() => setSending(false));
	};
	if (prompt.type === "select")
		return (
			<div className="login-step">
				<p>{prompt.message}</p>
				<div className="list">
					{prompt.options.map((option) => (
						<button
							type="button"
							key={option.id}
							className="row-button"
							disabled={sending}
							onClick={() => answer(option.id)}
						>
							<span>{option.label}</span>
							<ChevronIcon />
						</button>
					))}
				</div>
				{error && <p className="error small">{error}</p>}
			</div>
		);
	return (
		<form
			className="login-step"
			onSubmit={(event) => {
				event.preventDefault();
				answer(value);
			}}
		>
			<label className="label" htmlFor="login-value">
				{prompt.message}
			</label>
			{prompt.type === "manual_code" && (
				<p className="muted small">
					Complete sign-in in the provider tab, then paste the authorization code or final redirect URL below. If
					you land on an unreachable localhost page, copy its full address from the address bar and paste it here;
					that page does not need to load.
				</p>
			)}
			<input
				id="login-value"
				className="input"
				type={prompt.type === "secret" ? "password" : "text"}
				autoComplete="off"
				placeholder={prompt.placeholder}
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			{error && <p className="error small">{error}</p>}
			<button type="submit" className="login-continue" disabled={sending}>
				<span>Continue</span>
				<ChevronIcon />
			</button>
		</form>
	);
}

/** The provider list, one provider's actions, or the running login. Closing the sheet cancels an unfinished one. */
function ProvidersSheet({ onClose }: { onClose: () => void }) {
	const login = useObject(ProviderLogin, {});
	const providers = useReadable(login?.providers) ?? [];
	const state = useReadable(login?.login) ?? null;
	const [query, setQuery] = useState("");
	const nav = useNavigation();
	const route = useRoute();
	const selected = useSheet("providers")?.locator;
	const current = useRef(state);
	current.current = state;
	const host = useHost();
	// Keep a hold through cleanup: useObject releases its own handle first on ×/Escape.
	// Back leaves the sheet mounted, but must still end the provider's flow as in Pi Mobile.
	useEffect(() => {
		if (!login || !selected) return;
		const held = host.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		return () => {
			const flow = current.current;
			if (flow?.providerId !== selected) {
				held.release();
				return;
			}
			const cancel =
				flow.status === "working"
					? held.cancel({ attemptId: flow.attemptId }, BACKGROUND_CONTEXT)
					: Promise.resolve();
			void cancel
				.then(() => held.dismiss({ attemptId: flow.attemptId }, BACKGROUND_CONTEXT))
				.catch(() => {})
				.finally(() => held.release());
		};
	}, [host, login, selected]);
	const [result, setResult] = useState<string>();
	const [busy, setBusy] = useState(false);
	// Provider errors go to the app's toast, as in Pi Mobile (a prompt's own error stays in its form).
	const { setError } = useComposerState();
	const perform = (action: Promise<unknown> | undefined) => {
		void action?.catch((reason: unknown) => setError(errorText(reason)));
	};
	const providerId = selected;
	const provider = providers.find((entry) => entry.id === providerId);
	if (login && provider) {
		const back = () => {
			setResult(undefined);
			void nav.close({ ...route, layers: [...route.layers.slice(0, -1), { kind: "sheet", name: "providers" }] });
		};
		if (state && state.providerId === selected)
			return (
				<Sheet title={provider.name} onClose={onClose} className="login-sheet">
					<div className="login-flow">
						{state.notices.map((entry) => (
							<Notice key={entry.id} event={entry.event} />
						))}
						{state.prompt && <PromptForm key={state.prompt.id} state={state} login={login} />}
						{state.status === "working" && !state.prompt && !state.notices.length && (
							<div className="spinner large" />
						)}
						{state.status === "success" && (
							<p className="success">
								<CheckIcon /> {state.message ?? "Signed in."}
							</p>
						)}
						{state.status !== "working" && state.status !== "success" && (
							<p className={state.status === "error" ? "error" : "muted"}>{state.message}</p>
						)}
						{state.status === "working" ? (
							<button
								type="button"
								className="text-action"
								onClick={() => perform(login.cancel({ attemptId: state.attemptId }, BACKGROUND_CONTEXT))}
							>
								Cancel
							</button>
						) : (
							<button type="button" className="text-action" onClick={back}>
								Done
							</button>
						)}
					</div>
				</Sheet>
			);
		return (
			<Sheet title={provider.name} onClose={onClose} className="login-sheet">
				<div className="provider-detail">
					<p className="muted small">
						{provider.signedIn
							? `Signed in with ${provider.signedIn === "oauth" ? "a subscription" : "an API key"}.`
							: "Not signed in. Environment keys may still apply."}{" "}
						<span>Credentials are stored on the server.</span>
					</p>
					<div className="login-actions">
						{provider.loginMethods.map((method) => (
							<button
								type="button"
								key={method.type}
								className="login-action primary"
								onClick={() =>
									perform(login.start({ providerId: provider.id, authType: method.type }, BACKGROUND_CONTEXT))
								}
							>
								<span>{method.label}</span>
								<ChevronIcon />
							</button>
						))}
						{provider.signedIn && (
							<button
								type="button"
								className="login-action"
								disabled={busy}
								onClick={() => {
									setBusy(true);
									setResult(undefined);
									login
										.refresh({ providerId: provider.id }, BACKGROUND_CONTEXT)
										.then(({ models }) =>
											setResult(
												models
													? `${models} model${models === 1 ? "" : "s"} available.`
													: "Catalog updated; no models reported.",
											),
										)
										.catch((reason: unknown) => setError(errorText(reason)))
										.finally(() => setBusy(false));
								}}
							>
								<span>{busy ? "Updating model catalog…" : "Update model catalog"}</span>
								{!busy && <ChevronIcon />}
							</button>
						)}
						{provider.signedIn && (
							<button
								type="button"
								className="login-action danger"
								onClick={() => perform(login.logout({ providerId: provider.id }, BACKGROUND_CONTEXT))}
							>
								<span>Sign out</span>
							</button>
						)}
					</div>
					{result && <p className="provider-result">{result}</p>}
					<button type="button" className="text-action" onClick={back}>
						← All providers
					</button>
				</div>
			</Sheet>
		);
	}
	const terms = query.toLowerCase();
	const listed = providers
		.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(terms))
		.sort((a, b) => Number(Boolean(b.signedIn)) - Number(Boolean(a.signedIn)) || a.name.localeCompare(b.name));
	return (
		<Sheet title="Providers" onClose={onClose} className="login-sheet">
			<div className="sheet-sticky">
				<label className="search">
					<SearchIcon />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search providers"
						aria-label="Search providers"
					/>
				</label>
			</div>
			<div className="list">
				{listed.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className="row-button"
						onClick={() => {
							setResult(undefined);
							// The provider screen replaces the list's layer (one step), as in Pi Mobile: Back closes onto
							// the entry before it, which shows the list.
							const top = route.layers.at(-1);
							if (top?.kind !== "sheet" || top.name !== "providers") return;
							void nav.push({
								...route,
								layers: [...route.layers.slice(0, -1), { kind: "sheet", name: "providers", locator: entry.id }],
							});
						}}
					>
						<span>{entry.name}</span>
						{entry.signedIn && <small className="row-value">Signed in</small>}
						<ChevronIcon />
					</button>
				))}
			</div>
		</Sheet>
	);
}

/** The sidebar footer's Providers button: any authenticated owner. */
function ProvidersButton() {
	const owner = useOwner();
	const open = useSheet("providers") !== undefined;
	if (!owner) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "providers" }, { fromDrawer: true })}
			>
				Providers
			</button>
			{open && <ProvidersSheet onClose={closeLayers} />}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-login", (self) => {
		self.contribute(Slots, { "sidebar-foot:providers": ProvidersButton });
	});
});
