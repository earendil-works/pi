/**
 * Provider login for pi-plus: the programmatic twin of pi's interactive /login.
 *
 * Builds a standalone ModelRuntime over a chosen agent dir (credential store =
 * <agentDir>/auth.json, the file pi reads at launch) and runs the provider's
 * interactive login — OAuth (opens the provider's login page in the browser)
 * when the provider offers it, else its API-key setup flow. The pi-plus CLI
 * uses this from `pipi profile add <name> -p <provider>` (a provider-only add
 * means "log this profile into the provider"), and pi-plus-sdk re-exports it
 * so embedding hosts can drive login with their own UI. pi's TUI /login is
 * disabled in pi-plus by the interactive-mode wrapper (see
 * packages/plus/loader/redirects.mjs) so credentials always land in a
 * profile's isolated agent dir.
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Credential } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../coding-agent/src/config.ts";
import { ModelRuntime } from "../../../coding-agent/src/core/model-runtime.ts";
import { openBrowser } from "../../../coding-agent/src/utils/open-browser.ts";

// The auth vocabulary hosts need to implement AuthInteraction (re-exported by
// pi-plus-sdk); types only, so nothing extra enters the runtime bundle.
export type { AuthEvent, AuthInfoLink, AuthInteraction, AuthPrompt, AuthType, Credential } from "@earendil-works/pi-ai";

export interface LoginProviderOptions {
	/** Agent dir whose auth.json stores the credential. Defaults to the active agent dir. */
	agentDir?: string;
	/** Flow UI callbacks. Defaults to a terminal interaction (stdin prompts + browser). */
	interaction?: AuthInteraction;
	/** Cancels the flow. */
	signal?: AbortSignal;
	/** Force a login method; defaults to oauth when the provider offers it, then api_key. */
	method?: AuthType;
}

/**
 * Run a provider's interactive login and persist the credential to
 * <agentDir>/auth.json (the same store pi uses at runtime, so a logged-in
 * profile dir works unmodified). Throws when the provider is unknown, has no
 * interactive login (ambient/environment-only auth), or the flow is cancelled.
 */
export async function loginProvider(providerId: string, options: LoginProviderOptions = {}): Promise<Credential> {
	const agentDir = options.agentDir ?? getAgentDir();
	// modelsPath null: login needs no model catalog; a profile's models.json is
	// owned by the hub materializer and must not be read into this runtime.
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		signal: options.signal,
	});
	const provider = runtime.getProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown provider '${providerId}'.`);
	}
	// Same preference as pi's /login selector: subscription login first, then
	// interactive API-key setup. Providers with neither are ambient-only.
	const method =
		options.method ?? (provider.auth.oauth ? "oauth" : provider.auth.apiKey?.login ? "api_key" : undefined);
	if (!method) {
		throw new Error(
			`Provider '${providerId}' has no interactive login (environment API key only). ` +
				"Store a token with 'pipi profile update <name> -t <key>'.",
		);
	}
	const interaction = options.interaction ?? createTerminalAuthInteraction();
	// ModelRuntime.login keys cancellation off interaction.signal only — the
	// create() signal above covers just the init refresh — so fold options.signal
	// into the interaction for embedded hosts that cancel without dying.
	const signal =
		options.signal && interaction.signal
			? AbortSignal.any([options.signal, interaction.signal])
			: (options.signal ?? interaction.signal);
	return runtime.login(providerId, method, { ...interaction, signal });
}

/**
 * Readline-based AuthInteraction for terminal use: prints prompts to stdout
 * (select as a numbered list; secret values are read with terminal echo, not
 * masked) and opens auth URLs via the platform browser. One readline interface
 * per question so stdin is released as soon as the flow completes.
 */
export function createTerminalAuthInteraction(): AuthInteraction {
	return {
		prompt: (prompt) => answerPrompt(prompt),
		notify: (event) => showAuthEvent(event),
	};
}

function askLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve, reject) => {
		let settled = false;
		rl.question(question, (answer) => {
			settled = true;
			rl.close();
			resolve(answer.trim());
		});
		// stdin closed without an answer (e.g. a non-interactive run): reject so
		// the login fails with "cancelled" instead of hanging on the question.
		rl.once("close", () => {
			if (!settled) {
				reject(new Error("Login cancelled (no terminal input)"));
			}
		});
	});
}

/** Reject a pending question when its per-step signal aborts (e.g. a
 *  manual-code prompt raced by the loopback callback server). */
function withAbort(promise: Promise<string>, signal?: AbortSignal): Promise<string> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function answerPrompt(prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const lines = [`\n${prompt.message}`];
		prompt.options.forEach((option, index) => {
			const description = option.description ? ` — ${option.description}` : "";
			lines.push(`  ${index + 1}. ${option.label}${description}`);
		});
		console.log(lines.join("\n"));
		const answer = await withAbort(askLine(`Enter number (1-${prompt.options.length}): `), prompt.signal);
		const selected = prompt.options[Number.parseInt(answer, 10) - 1];
		if (!selected) {
			throw new Error(`Invalid selection '${answer}'.`);
		}
		return selected.id;
	}
	const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : "";
	return withAbort(askLine(`${prompt.message}${placeholder}: `), prompt.signal);
}

function showAuthEvent(event: AuthEvent): void {
	switch (event.type) {
		case "auth_url":
			console.log(`\n${event.instructions ?? "Complete the sign-in in your browser."}`);
			console.log(`  ${event.url}`);
			openBrowser(event.url);
			break;
		case "device_code":
			console.log(`\nEnter code ${event.userCode} at ${event.verificationUri}`);
			openBrowser(event.verificationUri);
			break;
		case "info": {
			console.log(`\n${event.message}`);
			for (const link of event.links ?? []) {
				console.log(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
			}
			break;
		}
		case "progress":
			console.log(event.message);
			break;
	}
}
