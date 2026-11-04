// `/login` and `/logout` in the TUI (p2-tui-port.md P6), after coding-agent's oauth-selector and login-dialog on
// `ProviderLogin` (owner only). Differences from pi, for a remote, sandboxed TUI: no browser is opened and nothing is
// copied by this worker. Opening the sign-in URL and copying it are launcher actions (`openUrl` external, `copy`),
// each confirmed in the launcher's own screen; secret prompts are masked and never echoed, kept in history, the reload
// snapshot or status lines.

import type { AuthEvent } from "@earendil-works/pi-ai";
import { type Component, type Focusable, Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, follow, liveIn, statusOf, whenLive } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import { ListOverlay, lineText, SecretInput, type TuiCommand, TuiCommands } from "@p2/app/v1/tui";
import { type LoginState, ProviderLogin } from "./contract.ts";

type Provider = {
	id: string;
	name: string;
	loginMethods: { type: "api_key" | "oauth"; label: string }[];
	signedIn: string | null;
};
const MANUAL_CODE_HELP =
	"Complete sign-in in your browser, then paste the authorization code or the final redirect URL here. If you land on an unreachable localhost page, copy its full address; that page does not need to load.";

/** The URL a notice offers (sign-in page or device verification page), when it is https or http. */
function noticeUrl(event: AuthEvent): string | undefined {
	const url = event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : undefined;
	if (!url) return undefined;
	try {
		return ["https:", "http:"].includes(new URL(url).protocol) ? url : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the notice's page may be offered for opening: a provider may ask clients not to (`openBrowserOnConfirm`). */
const opensInBrowser = (event: AuthEvent): boolean =>
	event.type !== "device_code" || event.openBrowserOnConfirm !== false;

/** The login flow of one provider, rendered from the server's `LoginState` (pi's LoginDialogComponent). */
export class LoginDialog implements Component, Focusable {
	private isFocused = false;
	private readonly ctx: TuiContext;
	private readonly ref: Held<typeof ProviderLogin>;
	private readonly provider: Provider;
	private readonly onDone: () => void;
	private state: LoginState | null = null;
	private promptId: string | undefined;
	private input = new Input();
	private secret: SecretInput;
	private select: SelectList | undefined;
	private status = "";
	private stop: () => void;
	private closed = false;
	constructor(ctx: TuiContext, ref: Held<typeof ProviderLogin>, provider: Provider, onDone: () => void) {
		this.ctx = ctx;
		this.ref = ref;
		this.provider = provider;
		this.onDone = onDone;
		this.secret = new SecretInput(ctx);
		this.input.onSubmit = (value) => this.answer(value);
		this.secret.onSubmit = (value) => this.answer(value);
		this.stop =
			statusOf(ref) === "live" && ref.variant === "owner"
				? follow(ref.login, (state) => {
						this.state = state ?? null;
						this.syncPrompt();
						ctx.requestRender();
					})
				: () => {};
	}
	get focused(): boolean {
		return this.isFocused;
	}
	set focused(value: boolean) {
		this.isFocused = value;
		this.input.focused = value;
		this.secret.focused = value;
	}
	private owner() {
		const ref = this.ref;
		return liveIn(ref, "owner");
	}
	private current(): LoginState | null {
		return this.state && this.state.providerId === this.provider.id ? this.state : null;
	}
	/** A new prompt gets fresh inputs; nothing typed for an earlier prompt survives. */
	private syncPrompt(): void {
		const prompt = this.current()?.prompt ?? null;
		if (prompt?.id === this.promptId) return;
		this.promptId = prompt?.id;
		this.input.setValue("");
		this.secret.clear();
		this.select = undefined;
		if (prompt?.type === "select" && "options" in prompt) {
			const options = prompt.options as readonly { id: string; label: string; description?: string }[];
			this.select = new SelectList(
				options.map((option) => ({
					value: option.id,
					label: lineText(option.label),
					...(option.description ? { description: lineText(option.description) } : {}),
				})),
				8,
				this.ctx.theme.selectList,
			);
			this.select.onSelect = (item) => this.answer(item.value);
			this.select.onCancel = () => this.cancel();
		}
	}
	private answer(value: string): void {
		const state = this.current();
		const ref = this.owner();
		const prompt = state?.prompt;
		if (!state || !prompt || !ref) return;
		const secret = prompt.type === "secret";
		this.status = "";
		this.ctx.requestRender();
		void ref
			.answer({ attemptId: state.attemptId, promptId: prompt.id, value }, BACKGROUND_CONTEXT)
			.catch((error: unknown) => {
				// Never echo a secret, even inside a server error.
				let message = error instanceof Error ? error.message : String(error);
				if (secret && value) message = message.split(value).join("•••");
				this.status = lineText(message);
				this.ctx.requestRender();
			});
		this.input.setValue("");
		this.secret.clear();
	}
	/** The latest notice offering a URL, and the URL. */
	private latest(): { event: AuthEvent; url: string } | undefined {
		const notices = this.current()?.notices ?? [];
		for (let index = notices.length - 1; index >= 0; index--) {
			const event = notices[index]!.event;
			const url = noticeUrl(event);
			if (url) return { event, url };
		}
		return undefined;
	}
	/** Opening the page is the launcher's (`openUrl` external, https only; it shows the full URL first). */
	private openUrl(): void {
		const latest = this.latest();
		if (!latest || !opensInBrowser(latest.event)) return;
		const { url } = latest;
		void this.ctx.grant("openUrl", { kind: "external", url }).then((result) => {
			if (!result.ok && result.error !== "denied") {
				this.status = url.startsWith("https:")
					? `Not opened (${result.error})`
					: "Only https pages can be opened; copy the address instead";
				this.ctx.requestRender();
			}
		});
	}
	private copyUrl(): void {
		const url = this.latest()?.url;
		if (url) void this.ctx.grant("copy", { text: url, label: "the sign-in address" });
	}
	private cancel(): void {
		const state = this.current();
		const ref = this.owner();
		if (state?.status === "working" && ref)
			void ref.cancel({ attemptId: state.attemptId }, BACKGROUND_CONTEXT).catch(() => {});
		else this.close();
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stop();
		this.input.setValue("");
		this.secret.clear();
		const state = this.current();
		const ref = this.owner();
		if (state && ref) {
			// A cancelled flow settles asynchronously; only a settled login can be dismissed.
			const settled = new Promise<void>((resolve) => {
				const timer = setTimeout(done, 5000);
				let stop: () => void = () => {};
				function done(): void {
					clearTimeout(timer);
					queueMicrotask(() => stop());
					resolve();
				}
				stop = follow(ref.login, (current) => {
					if (current === undefined) return;
					if (current === null || current.attemptId !== state.attemptId || current.status !== "working") done();
				});
			});
			const cancel =
				state.status === "working"
					? ref.cancel({ attemptId: state.attemptId }, BACKGROUND_CONTEXT)
					: Promise.resolve(null);
			void cancel
				.then(() => settled)
				.then(() => ref.dismiss({ attemptId: state.attemptId }, BACKGROUND_CONTEXT))
				.catch(() => {})
				.finally(() => ref.release());
		} else this.ref.release();
		this.onDone();
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		const state = this.current();
		const prompt = state?.prompt;
		if (this.select && prompt?.type === "select") {
			this.select.handleInput(data);
			return;
		}
		if (keys.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		// pi: app.message.copy copies the sign-in URL (the launcher suspends its own copy key while this dialog has focus).
		if (keys.matches(data, "app.message.copy")) {
			this.copyUrl();
			return;
		}
		if (!prompt) {
			if (keys.matches(data, "tui.select.confirm")) {
				if (state && state.status !== "working") this.close();
				else this.openUrl();
			}
			return;
		}
		if (keys.matches(data, "app.tools.expand")) {
			this.openUrl();
			return;
		}
		if (prompt.type === "secret") this.secret.handleInput(data);
		else this.input.handleInput(data);
	}
	private notice(event: AuthEvent): string[] {
		const theme = this.ctx.theme.current;
		switch (event.type) {
			case "auth_url":
				return [
					theme.fg("accent", lineText(event.url)),
					...(event.instructions ? [theme.fg("warning", lineText(event.instructions))] : []),
				];
			case "device_code":
				return [
					theme.fg("accent", lineText(event.verificationUri)),
					theme.fg("warning", `Enter code: ${lineText(event.userCode)}`),
				];
			case "progress":
				return [theme.fg("dim", lineText(event.message))];
			case "info":
				return [
					lineText(event.message),
					...(event.links ?? []).map((link) =>
						theme.fg("accent", lineText(link.label ? `${link.label}: ${link.url}` : link.url)),
					),
				];
		}
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const hint = (id: string, label: string) => this.ctx.hints.key(id, label);
		const wrap = (line: string) => truncateToWidth(` ${line}`, width, "…");
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const state = this.current();
		const lines = [border, wrap(theme.fg("accent", theme.bold(`Login to ${lineText(this.provider.name)}`))), ""];
		if (!state) lines.push(wrap(theme.fg("dim", "Starting…")));
		for (const entry of state?.notices ?? []) lines.push(...this.notice(entry.event).map(wrap));
		const prompt = state?.prompt;
		if (prompt) {
			lines.push("", wrap(lineText(prompt.message)));
			if (prompt.type === "manual_code") lines.push(wrap(theme.fg("dim", MANUAL_CODE_HELP)));
			if ("placeholder" in prompt && typeof prompt.placeholder === "string" && prompt.type !== "secret")
				lines.push(wrap(theme.fg("dim", `e.g., ${lineText(prompt.placeholder)}`)));
			if (prompt.type === "select" && this.select) lines.push(...this.select.render(width));
			else if (prompt.type === "secret") {
				lines.push(...this.secret.render(width - 1).map((line) => ` ${line}`));
				lines.push(wrap(theme.fg("dim", "Hidden as you type; never shown again")));
			} else lines.push(...this.input.render(width - 1).map((line) => ` ${line}`));
		}
		if (state?.status === "success")
			lines.push("", wrap(theme.fg("success", `✓ ${lineText(state.message ?? "Signed in.")}`)));
		else if (state && state.status !== "working")
			lines.push(
				"",
				wrap(theme.fg(state.status === "error" ? "error" : "muted", lineText(state.message ?? state.status))),
			);
		if (this.status) lines.push(wrap(theme.fg("error", this.status)));
		const latest = this.latest();
		const url = latest?.url;
		const opens = latest !== undefined && opensInBrowser(latest.event);
		const hints =
			state && state.status !== "working"
				? [hint("tui.select.confirm", "close")]
				: [
						...(opens && !prompt ? [hint("tui.select.confirm", "open in browser")] : []),
						...(opens && prompt && prompt.type !== "select" ? [hint("app.tools.expand", "open in browser")] : []),
						...(url ? [hint("app.message.copy", "copy address")] : []),
						...(prompt && prompt.type !== "select" ? [hint("tui.input.submit", "submit")] : []),
						hint("tui.select.cancel", "cancel"),
					];
		lines.push("", wrap(hints.join(theme.fg("dim", " · "))), border);
		return lines;
	}
	invalidate(): void {
		this.input.invalidate();
		this.select?.invalidate();
	}
	/** Called when the overlay closes for any reason: ends an unfinished login and releases the hold. */
	dispose(): void {
		this.close();
	}
}

/** Holds `ProviderLogin` for the whole flow (the server cancels an unfinished login once no hold remains). */
async function providerLogin(ctx: TuiContext): Promise<Held<typeof ProviderLogin> | undefined> {
	const ref = ctx.host.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	try {
		await whenLive(ref);
	} catch (error) {
		ref.release();
		ctx.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
	if (ref.variant !== "owner") {
		ref.release();
		return undefined;
	}
	return ref;
}
async function providers(ref: Held<typeof ProviderLogin>): Promise<Provider[]> {
	if (ref.variant !== "owner") return [];
	return new Promise((resolve) => {
		const stop = follow(ref.providers, (value) => {
			if (value === undefined) return;
			queueMicrotask(() => stop());
			resolve(value as Provider[]);
		});
	});
}
const find = (list: Provider[], name: string | undefined) =>
	name ? list.find((entry) => entry.id === name || entry.name.toLowerCase() === name.toLowerCase()) : undefined;

function choose(
	ctx: TuiContext,
	id: string,
	title: string,
	rows: { key: string; label: string; detail?: string }[],
	onSelect: (key: string | undefined) => void,
): void {
	let done = false;
	const finish = (key: string | undefined) => {
		if (done) return;
		done = true;
		overlay.close();
		onSelect(key);
	};
	const overlay = ctx.overlay(
		id,
		new ListOverlay(ctx, {
			title,
			rows: () => rows,
			onSelect: (row) => finish(row.key),
			onClose: () => finish(undefined),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

function start(ctx: TuiContext, ref: Held<typeof ProviderLogin>, provider: Provider, authType: "api_key" | "oauth") {
	if (ref.variant !== "owner") return;
	const dialog = new LoginDialog(ctx, ref, provider, () => overlay.close());
	const overlay = ctx.overlay("login", dialog, { width: "100%", anchor: "bottom-center" });
	void ref.start({ providerId: provider.id, authType }, BACKGROUND_CONTEXT).catch((error: unknown) => {
		ctx.notify(error instanceof Error ? error.message : String(error), "error");
		dialog.close();
	});
}

async function login(ctx: TuiContext, name: string | undefined): Promise<void> {
	const ref = await providerLogin(ctx);
	if (!ref) return;
	const list = (await providers(ref)).filter((entry) => entry.loginMethods.length);
	const pick = (provider: Provider | undefined) => {
		if (!provider) {
			ref.release();
			return;
		}
		if (provider.loginMethods.length === 1) {
			start(ctx, ref, provider, provider.loginMethods[0]!.type);
			return;
		}
		choose(
			ctx,
			"login-method",
			`Login to ${lineText(provider.name)}`,
			provider.loginMethods.map((method) => ({ key: method.type, label: lineText(method.label) })),
			(key) => {
				const method = provider.loginMethods.find((entry) => entry.type === key);
				if (method) start(ctx, ref, provider, method.type);
				else ref.release();
			},
		);
	};
	const named = find(list, name);
	if (name && !named) ctx.notify(`Unknown provider: ${lineText(name)}`, "warning");
	if (named) pick(named);
	else
		choose(
			ctx,
			"login-provider",
			"Select provider to login",
			list.map((entry) => ({
				key: entry.id,
				label: lineText(entry.name),
				detail: entry.signedIn ? `✓ ${entry.signedIn === "oauth" ? "subscription" : "API key"}` : "",
			})),
			(key) => pick(list.find((entry) => entry.id === key)),
		);
}

async function logout(ctx: TuiContext, name: string | undefined): Promise<void> {
	const ref = await providerLogin(ctx);
	if (!ref || ref.variant !== "owner") return;
	const list = (await providers(ref)).filter((entry) => entry.signedIn);
	const run = (provider: Provider | undefined) => {
		if (!provider) {
			ref.release();
			return;
		}
		void ref
			.logout({ providerId: provider.id }, BACKGROUND_CONTEXT)
			.then(() => ctx.notify(`Logged out of ${lineText(provider.name)}`))
			.catch((error: unknown) => ctx.notify(error instanceof Error ? error.message : String(error), "error"))
			.finally(() => ref.release());
	};
	if (!list.length) {
		ctx.notify("No stored provider credentials. Environment keys may still apply.", "warning");
		ref.release();
		return;
	}
	const named = find(list, name);
	if (name && !named) ctx.notify(`Not signed in to ${lineText(name)}`, "warning");
	if (named) run(named);
	else
		choose(
			ctx,
			"logout-provider",
			"Select provider to logout",
			list.map((entry) => ({ key: entry.id, label: lineText(entry.name) })),
			(key) => run(list.find((entry) => entry.id === key)),
		);
}

const complete = async (prefix: string, ctx: TuiContext, signedIn: boolean) => {
	const ref = await providerLogin(ctx);
	if (!ref) return null;
	try {
		const list = (await providers(ref)).filter((entry) => (signedIn ? entry.signedIn : entry.loginMethods.length));
		return list
			.filter((entry) => entry.id.startsWith(prefix.trim()))
			.map((entry) => ({ value: entry.id, label: entry.id, description: lineText(entry.name) }));
	} finally {
		ref.release();
	}
};

const COMMANDS: Record<string, TuiCommand> = {
	"p2.login": {
		title: "Login to a model provider",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "login", argumentHint: "[provider]", complete: (prefix, ctx) => complete(prefix, ctx, false) },
		run: (ctx, args) => login(ctx, args),
	},
	"p2.logout": {
		title: "Logout from a model provider",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "logout", argumentHint: "[provider]", complete: (prefix, ctx) => complete(prefix, ctx, true) },
		run: (ctx, args) => logout(ctx, args),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-login", (self) => {
		self.contribute(TuiCommands, COMMANDS);
	}),
);
