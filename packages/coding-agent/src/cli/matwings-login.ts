// MatwingsVenus login/logout CLI — terminal (readline) UI that drives the
// pure matwings-auth core. This is the "thin terminal adapter"; the core
// (client/storage/session) is TUI-agnostic and reused as-is by the Phase-2
// Electron GUI (which swaps this for a GUI window).

import process from "node:process";
import { APP_NAME } from "../config.ts";
import {
	ApiError,
	applySignIn,
	bindAccount,
	computeBindingRequirement,
	encryptPassword,
	ensureValidAuth,
	fetchPublicKey,
	getSystemFeature,
	isAccountSelection,
	loginPassword,
	loginWithCode,
	logout as logoutCore,
	selectAccount,
	sendBindCode,
	sendLoginCode,
	type AccountSelectionResult,
	type BindingRequirement,
	type BindingType,
	type LoginResult,
	type SignInResult,
} from "../core/matwings-auth/index.ts";

// ---- low-level masked/unmasked line input (raw mode) ----------------------

async function readLineMasked(mask: boolean): Promise<string> {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const isTty = stdin.isTTY;
		const wasRaw = isTty ? stdin.isRaw : false;
		if (isTty) stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		let value = "";
		const onData = (data: string) => {
			for (const char of data) {
				const code = char.codePointAt(0) ?? 0;
				if (code === 13 || code === 10) {
					// Enter
					cleanup();
					process.stdout.write("\n");
					resolve(value);
					return;
				}
				if (code === 3) {
					// Ctrl-C
					cleanup();
					process.exit(130);
				}
				if (code === 4) {
					// Ctrl-D
					cleanup();
					process.stdout.write("\n");
					resolve(value);
					return;
				}
				if (code === 127 || code === 8) {
					// Backspace
					if (value.length > 0) {
						value = value.slice(0, -1);
						process.stdout.write("\b \b");
					}
				} else if (code >= 32 && code !== 127) {
					value += char;
					process.stdout.write(mask ? "*" : char);
				}
			}
		};
		const cleanup = () => {
			stdin.removeListener("data", onData);
			if (isTty) stdin.setRawMode(wasRaw);
			stdin.pause();
		};
		stdin.on("data", onData);
	});
}

async function promptText(label: string): Promise<string> {
	process.stdout.write(label);
	return (await readLineMasked(false)).trim();
}

async function promptPassword(label: string): Promise<string> {
	process.stdout.write(label);
	return await readLineMasked(true);
}

async function promptSelect(label: string, options: string[]): Promise<number> {
	process.stdout.write(`\n${label}\n`);
	for (let i = 0; i < options.length; i++) process.stdout.write(`  ${i + 1}) ${options[i]}\n`);
	while (true) {
		const answer = await promptText("> ");
		const n = Number.parseInt(answer, 10);
		if (!Number.isNaN(n) && n >= 1 && n <= options.length) return n - 1;
		process.stdout.write("Invalid choice.\n");
	}
}

async function promptConfirm(label: string): Promise<boolean> {
	const answer = (await promptText(`${label} [y/N] `)).toLowerCase();
	return answer === "y" || answer === "yes";
}

function formatError(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

// ---- account selection -----------------------------------------------------

async function resolveAccountSelection(selection: AccountSelectionResult): Promise<SignInResult> {
	const labels = selection.accounts.map((account) => {
		const parts = [account.name];
		if (account.org_name) parts.push(`(${account.org_name})`);
		if (account.account_type) parts.push(`[${account.account_type}]`);
		return parts.join(" ");
	});
	const index = await promptSelect("Multiple accounts found. Select one:", labels);
	const chosen = selection.accounts[index];
	if (chosen === undefined) throw new Error("No account selected");
	return selectAccount(selection.selection_token, chosen.user_id);
}

// ---- binding ---------------------------------------------------------------

async function chooseBindingChannel(): Promise<"phone" | "email"> {
	const index = await promptSelect("Bind channel:", ["Phone", "Email"]);
	return index === 1 ? "email" : "phone";
}

async function runBindingFlow(accessToken: string, requirement: BindingRequirement): Promise<void> {
	const channel: "phone" | "email" =
		requirement.type === "any"
			? await chooseBindingChannel()
			: requirement.type === "email"
				? "email"
				: "phone";

	for (let attempt = 0; attempt < 3; attempt++) {
		const identifier = await promptText(`${channel === "phone" ? "Phone" : "Email"}: `);
		try {
			await sendBindCode(accessToken, identifier);
			process.stdout.write("Verification code sent.\n");
			const code = await promptText("Code (6 digits): ");
			const pub = await fetchPublicKey();
			const currentPassword = await promptPassword("Current account password: ");
			await bindAccount(accessToken, identifier, code, encryptPassword(currentPassword, pub.public_key_pem));
			process.stdout.write("Binding successful.\n");
			return;
		} catch (error) {
			process.stdout.write(`Binding failed: ${formatError(error)}\n`);
			if (requirement.mandatory) {
				const retry = await promptConfirm("Retry binding?");
				if (!retry) {
					await logoutCore();
					process.stdout.write("Logged out (binding is required).\n");
					process.exit(1);
				}
			} else {
				return;
			}
		}
	}
}

async function runBindingIfNeeded(accessToken: string, signIn: SignInResult): Promise<void> {
	const bindingType: BindingType | null | undefined = signIn.binding_type;
	if (!signIn.binding_required || !bindingType) return;
	let feature;
	try {
		feature = await getSystemFeature();
	} catch {
		feature = undefined;
	}
	const requirement = computeBindingRequirement(signIn, feature);
	if (!requirement) return;
	if (!requirement.mandatory) {
		const ok = await promptConfirm("Bind a phone or email now?");
		if (!ok) return;
	}
	await runBindingFlow(accessToken, requirement);
}

// ---- login flow ------------------------------------------------------------

export async function runLoginFlow(): Promise<SignInResult | null> {
	process.stdout.write("\n=== MatwingsVenus login ===\n");
	try {
		const modeIndex = await promptSelect("Login method:", ["Password", "Verification code"]);
		const identifier = await promptText("Email or phone: ");

		let result: LoginResult;
		if (modeIndex === 0) {
			const pub = await fetchPublicKey();
			const password = await promptPassword("Password: ");
			result = await loginPassword(identifier, encryptPassword(password, pub.public_key_pem));
		} else {
			await sendLoginCode(identifier);
			process.stdout.write("Verification code sent.\n");
			const code = await promptText("Code: ");
			result = await loginWithCode(identifier, code);
		}

		const signIn = isAccountSelection(result) ? await resolveAccountSelection(result) : result;
		const stored = await applySignIn(signIn);
		await runBindingIfNeeded(stored.access_token, signIn);
		process.stdout.write(`\nLogged in as ${stored.user.name ?? stored.user.id}.\n`);
		return signIn;
	} catch (error) {
		process.stdout.write(`\nLogin failed: ${formatError(error)}\n`);
		return null;
	}
}

// ---- gate + subcommands ----------------------------------------------------

/**
 * Access gate. Resolves immediately if a valid (possibly refreshed) token
 * exists. Otherwise prompts an interactive login (TTY) or errors out (non-TTY).
 */
export async function requireMatvenusAuth(): Promise<void> {
	const auth = await ensureValidAuth();
	if (auth) return;
	if (!process.stdin.isTTY) {
		process.stderr.write(`${APP_NAME}: not logged in. Run \`${APP_NAME} login\` first.\n`);
		process.exit(1);
	}
	const result = await runLoginFlow();
	if (!result) process.exit(1);
}

/** `matvenus login` — run the login flow (forces re-login). */
export async function runMatvenusLoginCommand(): Promise<void> {
	const result = await runLoginFlow();
	if (!result) process.exit(1);
}

/** `matvenus logout` — clear the stored session. */
export async function runMatvenusLogoutCommand(): Promise<void> {
	await logoutCore();
	process.stdout.write("Logged out.\n");
}
