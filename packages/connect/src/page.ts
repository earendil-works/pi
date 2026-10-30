/// <reference lib="dom" />

// pi.dev's sign-in popup: shows which site asks, runs the provider's sign-in, hands the credential to that site.

import type {
	AuthEvent,
	AuthPrompt,
	LoginOptions,
	OAuthAuth,
	OAuthCredential,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { getBuiltinOAuthFlow, registerOAuthFlows } from "@earendil-works/pi-ai/oauth-flows";
import { BUILTIN_AUTH_DOCUMENTS } from "./builtin-documents.ts";
import type { AuthDocument, AuthMethodDocument } from "./documents.ts";
import { CONNECT_PROTOCOL, type HelloMessage, type PopupMessage, parseHelloMessage } from "./messages.ts";
import { relayFetch } from "./relay.ts";
import { browserRefusal } from "./support.ts";

/**
 * Run the popup in `root`. The page learns the asking site from the browser (`event.origin` of the
 * app's hello), shows it before anything happens, and sends the credential to that origin only. It
 * keeps no credential: the sign-in lives in this page's memory. Only the ChatGPT sign-in's device ID
 * (one per asking site) stays in localStorage, because OpenAI identifies an installation by it.
 * Requests that browsers cannot send go through the relay of the origin serving this page.
 *
 * Other pages of the same origin must not reach into this window while it holds a credential. They
 * could only find it by its name, so the page drops any name it was opened with.
 */
export function runConnectPage(root: HTMLElement): void {
	window.name = "";
	registerOAuthFlows({ fetch: relayFetch(location.origin) });
	const view = new PopupView(root);
	const opener = window.opener as WindowProxy | null;
	if (!opener) {
		view.page("Nothing to sign in to", paragraph("Open this page from a site's sign-in button."));
		return;
	}
	void connect(opener, view);
}

/** A sign-in the page can run. */
interface SignInRequest {
	document: AuthDocument;
	method: AuthMethodDocument;
	flow: OAuthAuth;
}

async function connect(opener: WindowProxy, view: PopupView): Promise<void> {
	view.page("Connecting", paragraph("Waiting for the site that opened this window."));
	const { hello, origin } = await waitForHello(opener);
	const reply = (message: PopupMessage) => opener.postMessage(message, origin);
	const request = resolveRequest(hello, origin);
	if (typeof request === "string") {
		view.page("This sign-in is not available", paragraph(request));
		view.actions(button("Close", () => window.close()));
		reply({ protocol: CONNECT_PROTOCOL, type: "error", nonce: hello.nonce, message: request });
		return;
	}

	const controller = new AbortController();
	const cancel = () => {
		controller.abort();
		reply({ protocol: CONNECT_PROTOCOL, type: "cancelled", nonce: hello.nonce });
		window.close();
	};
	if (!(await view.consent(origin, request.document, request.method))) return cancel();

	view.page(`Sign in to ${request.document.name}`);
	view.actions(button("Cancel", cancel));
	let credential: OAuthCredential;
	try {
		credential = await request.flow.login(interaction(view, request.method, controller.signal), loginOptions(origin));
	} catch (error) {
		if (controller.signal.aborted) return;
		const message = error instanceof Error ? error.message : String(error);
		view.page("Sign-in failed", paragraph(message));
		view.actions(button("Close", () => window.close()));
		reply({ protocol: CONNECT_PROTOCOL, type: "error", nonce: hello.nonce, message });
		return;
	}
	reply({ protocol: CONNECT_PROTOCOL, type: "credential", nonce: hello.nonce, credential });
	view.page("Signed in", paragraph(`${origin} has your credential. You can close this window.`));
	window.close();
}

/** Announce the page to its opener and wait for the opener's hello. */
function waitForHello(opener: WindowProxy): Promise<{ hello: HelloMessage; origin: string }> {
	return new Promise((resolve) => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== opener) return;
			const hello = parseHelloMessage(event.data);
			if (!hello) return;
			window.removeEventListener("message", onMessage);
			resolve({ hello, origin: event.origin });
		};
		window.addEventListener("message", onMessage);
		const ready: PopupMessage = { protocol: CONNECT_PROTOCOL, type: "ready" };
		opener.postMessage(ready, "*");
	});
}

/** The sign-in a hello asks for, or why this page cannot run it. */
function resolveRequest(hello: HelloMessage, origin: string): SignInRequest | string {
	// Opaque origins (sandboxed frames, file pages) cannot receive a targeted message.
	if (origin === "null") return "The page that opened this window has no origin to send a credential to.";
	const document = BUILTIN_AUTH_DOCUMENTS.providers.find((candidate) => candidate.provider === hello.provider);
	const method = document?.methods.find((candidate) => candidate.id === hello.method && candidate.type === "oauth");
	const flow = getBuiltinOAuthFlow(hello.provider);
	if (!document || !method || !flow) return `pi.dev cannot sign in to "${hello.provider}" with "${hello.method}".`;
	return browserRefusal(document, method, { manual: hello.manual }) ?? { document, method, flow };
}

function loginOptions(origin: string): LoginOptions {
	return { getDeviceId: () => deviceId(origin), agentName: new URL(origin).host };
}

function deviceId(origin: string): string {
	const key = `pi-connect:device:${origin}`;
	const stored = localStorage.getItem(key);
	if (stored) return stored;
	const created = crypto.randomUUID();
	localStorage.setItem(key, created);
	return created;
}

/** The interaction a flow drives; the method selection is answered with the method the site asked for. */
function interaction(view: PopupView, method: AuthMethodDocument, signal: AbortSignal): ProviderAuthInteraction {
	return {
		signal,
		prompt: (prompt) =>
			prompt.type === "select" && prompt.options.some((option) => option.id === method.id)
				? Promise.resolve(method.id)
				: view.ask(prompt, signal),
		notify: (event) => view.show(event),
	};
}

/** The popup's DOM: a title, a body, a status line and actions. pi.dev styles the `connect-*` classes. */
class PopupView {
	private readonly title: HTMLElement;
	private readonly body: HTMLElement;
	private readonly statusLine: HTMLElement;
	private readonly actionBar: HTMLElement;

	constructor(root: HTMLElement) {
		this.title = element("h1", "connect-title");
		this.body = element("div", "connect-body");
		this.statusLine = element("p", "connect-status");
		this.statusLine.setAttribute("aria-live", "polite");
		this.actionBar = element("div", "connect-actions");
		root.replaceChildren(this.title, this.body, this.statusLine, this.actionBar);
	}

	/** Show a new step. */
	page(title: string, ...children: Node[]): void {
		this.title.textContent = title;
		this.body.replaceChildren(...children);
		this.statusLine.textContent = "";
		this.actionBar.replaceChildren();
	}

	actions(...buttons: HTMLButtonElement[]): void {
		this.actionBar.replaceChildren(...buttons);
	}

	/** Ask whether `origin` may receive a credential for the method. */
	consent(origin: string, document: AuthDocument, method: AuthMethodDocument): Promise<boolean> {
		const site = element("strong");
		site.textContent = origin;
		const ask = element("p");
		ask.append(site, ` asks to sign in to your ${document.name} account: ${method.label}.`);
		const notes = [
			ask,
			paragraph(`When you finish, pi.dev sends the credential to ${origin} only and keeps nothing.`),
		];
		if (method.browser.reason) notes.push(paragraph(method.browser.reason));
		this.page(`Sign in to ${document.name}?`, ...notes);
		return new Promise((resolve) => {
			const proceed = button("Continue", () => resolve(true));
			armWhenSeen(proceed);
			this.actions(
				proceed,
				button("Cancel", () => resolve(false)),
			);
		});
	}

	/** Render a flow event. */
	show(event: AuthEvent): void {
		switch (event.type) {
			case "progress":
				this.statusLine.textContent = event.message;
				return;
			case "info":
				this.statusLine.textContent = event.message;
				for (const link of event.links ?? []) {
					const line = paragraph();
					line.append(anchor(link.label ?? link.url, link.url));
					this.body.append(line);
				}
				return;
			case "auth_url":
				if (event.instructions) this.body.append(paragraph(event.instructions));
				this.body.append(anchor("Open the sign-in page", event.url));
				return;
			case "device_code": {
				const code = element("code", "connect-code");
				code.textContent = event.userCode;
				const copy = button("Copy", () => void navigator.clipboard.writeText(event.userCode));
				const where = isWebAddress(event.verificationUri) ? new URL(event.verificationUri).host : "the provider";
				this.body.append(
					paragraph(`Enter this code at ${where}:`),
					code,
					copy,
					anchor("Open the sign-in page", event.verificationUri),
				);
				return;
			}
		}
	}

	/** Render a prompt and resolve with the answer; rejects when the sign-in is cancelled. */
	ask(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
		const form = element("form", "connect-prompt");
		const done = AbortSignal.any(prompt.signal ? [signal, prompt.signal] : [signal]);
		const answer = new Promise<string>((resolve, reject) => {
			const settle = (value: string) => {
				form.remove();
				resolve(value);
			};
			done.addEventListener(
				"abort",
				() => {
					form.remove();
					reject(new Error("Login cancelled"));
				},
				{ once: true },
			);
			if (prompt.type === "select") {
				form.append(
					paragraph(prompt.message),
					...prompt.options.map((option) => button(option.label, () => settle(option.id))),
				);
				return;
			}
			const input = element("input", "connect-input");
			input.type = prompt.type === "secret" ? "password" : "text";
			input.placeholder = prompt.placeholder ?? "";
			input.autocomplete = "off";
			const label = element("label");
			label.append(prompt.message, input);
			const submit = element("button");
			submit.type = "submit";
			submit.textContent = "Continue";
			form.append(label, submit);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				settle(input.value);
			});
		});
		this.body.append(form);
		return answer;
	}
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

function paragraph(text = ""): HTMLParagraphElement {
	const node = element("p");
	node.textContent = text;
	return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
	const node = element("button", "connect-button");
	node.type = "button";
	node.textContent = label;
	node.addEventListener("click", onClick);
	return node;
}

const ARM_DELAY_MS = 700;

/**
 * Enable a control only once the window has been visible for a moment. A popup opens under the
 * pointer, so the second click of a double-click aimed at the opening page would otherwise land on
 * Continue (double-click hijacking).
 */
function armWhenSeen(control: HTMLButtonElement): void {
	control.disabled = true;
	const onVisible = () => {
		if (document.visibilityState !== "visible") return;
		document.removeEventListener("visibilitychange", onVisible);
		setTimeout(() => {
			control.disabled = false;
		}, ARM_DELAY_MS);
	};
	document.addEventListener("visibilitychange", onVisible);
	onVisible();
}

/**
 * A link that opens in a new tab. Addresses come from providers' responses (wire input); anything but
 * http(s), such as `javascript:`, would run in this page, so it is shown as text instead.
 */
function anchor(label: string, href: string): HTMLElement {
	if (!isWebAddress(href)) return paragraph(`${label}: the provider sent an address that is not a web page.`);
	const node = element("a", "connect-link");
	node.href = href;
	node.target = "_blank";
	node.rel = "noopener noreferrer";
	node.textContent = label;
	return node;
}

function isWebAddress(href: string): boolean {
	try {
		const protocol = new URL(href).protocol;
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}
