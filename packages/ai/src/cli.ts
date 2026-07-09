#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import lockfile from "proper-lockfile";
import { getOAuthProvider, getOAuthProviders } from "./utils/oauth/index.ts";
import type { OAuthCredentials, OAuthProviderId } from "./utils/oauth/types.ts";

const AUTH_FILE = "auth.json";
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const PROVIDERS = getOAuthProviders();

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

function loadAuth(): Record<string, { type: "oauth" } & OAuthCredentials> {
	if (!existsSync(AUTH_FILE)) return {};
	try {
		return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function saveAuth(auth: Record<string, { type: "oauth" } & OAuthCredentials>): void {
	const tempFile = `${AUTH_FILE}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempFile, JSON.stringify(auth, null, 2), {
			...AUTH_FILE_WRITE_OPTIONS,
			flag: "wx",
		});
		chmodSync(tempFile, 0o600);
		renameSync(tempFile, AUTH_FILE);
	} finally {
		rmSync(tempFile, { force: true });
	}
}

async function saveProviderAuth(providerId: OAuthProviderId, credentials: OAuthCredentials): Promise<void> {
	let compromisedError: Error | undefined;
	const release = await lockfile.lock(AUTH_FILE, {
		realpath: false,
		retries: {
			retries: 10,
			factor: 2,
			minTimeout: 100,
			maxTimeout: 1000,
			randomize: true,
		},
		stale: 30_000,
		onCompromised: (error) => {
			compromisedError = error;
		},
	});
	let saveError: unknown;
	try {
		if (compromisedError) throw compromisedError;
		const auth = loadAuth();
		auth[providerId] = { type: "oauth", ...credentials };
		saveAuth(auth);
		if (compromisedError) throw compromisedError;
	} catch (error) {
		saveError = error;
	}

	let releaseError: unknown;
	try {
		await release();
	} catch (error) {
		releaseError = error;
	}

	if (saveError) throw saveError;
	if (releaseError) throw releaseError;
}

async function login(providerId: OAuthProviderId): Promise<void> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		console.error(`Unknown provider: ${providerId}`);
		process.exit(1);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const promptFn = (msg: string) => prompt(rl, `${msg} `);

	try {
		const credentials = await provider.login({
			onAuth: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.url}`);
				if (info.instructions) console.log(info.instructions);
				console.log();
			},
			onDeviceCode: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.verificationUri}`);
				console.log(`Enter code: ${info.userCode}`);
				console.log();
			},
			onPrompt: async (p) => {
				return await promptFn(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
			onSelect: async (p) => {
				console.log(`\n${p.message}`);
				for (let i = 0; i < p.options.length; i++) {
					console.log(`  ${i + 1}. ${p.options[i].label}`);
				}
				const choice = await promptFn(`Enter number (1-${p.options.length}):`);
				const index = parseInt(choice, 10) - 1;
				return p.options[index]?.id;
			},
			onProgress: (msg) => console.log(msg),
		});

		await saveProviderAuth(providerId, credentials);

		console.log(`\nCredentials saved to ${AUTH_FILE}`);
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		const providerList = PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.name}`).join("\n");
		console.log(`Usage: npx @earendil-works/pi-ai <command> [provider]

Commands:
  login [provider]  Login to an OAuth provider
  list              List available providers

Providers:
${providerList}

Examples:
  npx @earendil-works/pi-ai login              # interactive provider selection
  npx @earendil-works/pi-ai login anthropic    # login to specific provider
  npx @earendil-works/pi-ai list               # list providers
`);
		return;
	}

	if (command === "list") {
		console.log("Available OAuth providers:\n");
		for (const p of PROVIDERS) {
			console.log(`  ${p.id.padEnd(20)} ${p.name}`);
		}
		return;
	}

	if (command === "login") {
		let provider = args[1] as OAuthProviderId | undefined;

		if (!provider) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			console.log("Select a provider:\n");
			for (let i = 0; i < PROVIDERS.length; i++) {
				console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
			}
			console.log();

			const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
			rl.close();

			const index = parseInt(choice, 10) - 1;
			if (index < 0 || index >= PROVIDERS.length) {
				console.error("Invalid selection");
				process.exit(1);
			}
			provider = PROVIDERS[index].id;
		}

		if (!PROVIDERS.some((p) => p.id === provider)) {
			console.error(`Unknown provider: ${provider}`);
			console.error(`Use 'npx @earendil-works/pi-ai list' to see available providers`);
			process.exit(1);
		}

		console.log(`Logging in to ${provider}...`);
		await login(provider);
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error(`Use 'npx @earendil-works/pi-ai --help' for usage`);
	process.exit(1);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
