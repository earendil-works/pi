/// <reference lib="dom" />

// The app side of pi.dev's sign-in popup: open it, introduce the app, receive the credential.

import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ConnectError } from "./errors.ts";
import { CONNECT_PROTOCOL, type HelloMessage, parsePopupMessage } from "./messages.ts";

/** What to sign in to. */
export interface PopupSignIn {
	provider: string;
	method: string;
	/** Whether the app allows sign-ins that end with pasting an address. */
	manual: boolean;
}

/** The page's window, as far as the popup needs it. */
export interface PopupHost {
	open(url: string, target: string, features: string): WindowProxy | null;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const POPUP_FEATURES = "popup,width=480,height=720";
const CLOSED_POLL_MS = 500;

/**
 * Sign in through pi.dev's popup and resolve with the credential. Call it from a click handler:
 * browsers block windows opened otherwise.
 */
export function signInWithPopup(
	piUrl: string,
	request: PopupSignIn,
	signal?: AbortSignal,
	host: PopupHost = window,
): Promise<OAuthCredential> {
	const piOrigin = new URL(piUrl).origin;
	const hello: HelloMessage = { protocol: CONNECT_PROTOCOL, type: "hello", nonce: crypto.randomUUID(), ...request };
	return new Promise((resolve, reject) => {
		let popup: WindowProxy | null = null;
		let introduced = false;
		const finish = (result: { credential: OAuthCredential } | { error: unknown }) => {
			clearInterval(closedPoll);
			host.removeEventListener("message", onMessage);
			signal?.removeEventListener("abort", onAbort);
			if ("credential" in result) resolve(result.credential);
			else reject(result.error);
		};
		const onMessage = (event: MessageEvent) => {
			if (event.source !== popup || event.origin !== piOrigin) return;
			const message = parsePopupMessage(event.data);
			if (!message) return;
			if (message.type === "ready") {
				introduced = true;
				popup?.postMessage(hello, piOrigin);
				return;
			}
			if (message.nonce !== hello.nonce) return;
			if (message.type === "credential") finish({ credential: message.credential });
			else if (message.type === "error") finish({ error: new ConnectError("sign_in_failed", message.message) });
			else finish({ error: new ConnectError("cancelled", "Sign-in was cancelled.") });
		};
		// Only the app's own abort closes the window; after a failure it shows the user what went wrong.
		const onAbort = () => {
			popup?.close();
			finish({ error: signal?.reason });
		};
		const closedPoll = setInterval(() => {
			if (!popup?.closed) return;
			finish({ error: new ConnectError("popup_closed", closedMessage(introduced)) });
		}, CLOSED_POLL_MS);

		host.addEventListener("message", onMessage);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) return onAbort();
		// `_blank`, never a name: `window.open` with a name reuses an existing window of that name, whose
		// opener (and so the origin the popup trusts) would be whoever created it.
		popup = host.open(new URL("/connect", piOrigin).href, "_blank", POPUP_FEATURES);
		if (!popup) {
			finish({
				error: new ConnectError(
					"popup_blocked",
					"The browser blocked the sign-in window. Start the sign-in from a click.",
				),
			});
		}
	});
}

function closedMessage(introduced: boolean): string {
	if (introduced) return "The sign-in window was closed before the sign-in finished.";
	// Without `ready`, the popup never reached this page: a Cross-Origin-Opener-Policy of `same-origin`
	// cuts the link between the two windows.
	return "The sign-in window closed before it could reach this page. If this page sends Cross-Origin-Opener-Policy: same-origin, use same-origin-allow-popups.";
}
