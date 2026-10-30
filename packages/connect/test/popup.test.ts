/// <reference lib="dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectError } from "../src/errors.ts";
import { CONNECT_PROTOCOL, type HelloMessage } from "../src/messages.ts";
import { type PopupHost, signInWithPopup } from "../src/popup.ts";

const PI = "https://pi.dev";
const credential = { type: "oauth" as const, access: "a", refresh: "r", expires: 1 };

/** A page window whose `open` returns a fake popup that records what the app posts to it. */
function fakeHost(options: { blocked?: boolean } = {}) {
	const listeners = new Set<(event: MessageEvent) => void>();
	const posted: { message: HelloMessage; targetOrigin: string }[] = [];
	const popup = {
		closed: false,
		postMessage: (message: HelloMessage, targetOrigin: string) => posted.push({ message, targetOrigin }),
		close() {
			this.closed = true;
		},
	};
	const opened: { url: string; target: string }[] = [];
	const host: PopupHost = {
		open: (url, target) => {
			opened.push({ url, target });
			return options.blocked ? null : (popup as unknown as WindowProxy);
		},
		addEventListener: (_type, listener) => listeners.add(listener),
		removeEventListener: (_type, listener) => listeners.delete(listener),
	};
	const send = (data: unknown, from: { origin?: string; source?: unknown } = {}) => {
		const event = { data, origin: from.origin ?? PI, source: from.source ?? popup } as MessageEvent;
		for (const listener of [...listeners]) listener(event);
	};
	return { host, popup, posted, send, opened };
}

const request = { provider: "xai", method: "device_code", manual: false };

afterEach(() => {
	vi.useRealTimers();
});

describe("signInWithPopup", () => {
	it("introduces the app once the popup is ready and resolves with its credential", async () => {
		const { host, posted, send, opened } = fakeHost();
		const result = signInWithPopup(PI, request, undefined, host);
		// A fresh window: a named one could be an existing window that someone else opened.
		expect(opened).toEqual([{ url: "https://pi.dev/connect", target: "_blank" }]);

		send({ protocol: CONNECT_PROTOCOL, type: "ready" });
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ targetOrigin: PI, message: { type: "hello", ...request } });
		const nonce = posted[0]!.message.nonce;

		send({ protocol: CONNECT_PROTOCOL, type: "credential", nonce: "other", credential });
		send({ protocol: CONNECT_PROTOCOL, type: "credential", nonce, credential }, { origin: "https://evil.example" });
		send({ protocol: CONNECT_PROTOCOL, type: "credential", nonce, credential }, { source: {} });
		send({ protocol: CONNECT_PROTOCOL, type: "credential", nonce, credential });
		await expect(result).resolves.toEqual(credential);
	});

	it("rejects with the popup's error", async () => {
		const { host, posted, send } = fakeHost();
		const result = signInWithPopup(PI, request, undefined, host);
		send({ protocol: CONNECT_PROTOCOL, type: "ready" });
		send({ protocol: CONNECT_PROTOCOL, type: "error", nonce: posted[0]!.message.nonce, message: "denied" });
		await expect(result).rejects.toMatchObject({ code: "sign_in_failed", message: "denied" });
	});

	it("reports a blocked window", async () => {
		const { host } = fakeHost({ blocked: true });
		await expect(signInWithPopup(PI, request, undefined, host)).rejects.toMatchObject({ code: "popup_blocked" });
	});

	it("explains a window that closed before it reached the page", async () => {
		vi.useFakeTimers();
		const { host, popup } = fakeHost();
		const result = signInWithPopup(PI, request, undefined, host);
		popup.closed = true;
		vi.advanceTimersByTime(500);
		await expect(result).rejects.toThrow(ConnectError);
		await expect(result).rejects.toThrow("Cross-Origin-Opener-Policy");
	});

	it("closes the popup when the app aborts", async () => {
		const { host, popup } = fakeHost();
		const controller = new AbortController();
		const result = signInWithPopup(PI, request, controller.signal, host);
		controller.abort(new Error("navigated away"));
		await expect(result).rejects.toThrow("navigated away");
		expect(popup.closed).toBe(true);
	});
});
