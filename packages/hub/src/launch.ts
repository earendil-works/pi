import { getDefaultProfileName, loadProfiles } from "./profiles.ts";

/** How the CLI should launch: under a materialized profile dir, or plain pi. */
export type LaunchPlan =
	| { kind: "profile"; name: string; remainingArgs: string[] }
	| { kind: "plain"; remainingArgs: string[] };

const PROFILE_FLAG = "--as";

function unknownProfile(name: string): Error {
	return new Error(`Profile '${name}' not found. Use 'pipi profile list' to see available profiles.`);
}

/**
 * Resolve how a pi invocation should launch:
 * - `--as <name>` / `--as=<name>` selects a profile (flag is stripped
 *   from the args passed through to pi)
 * - otherwise the stored default profile applies, when set
 * - otherwise the invocation runs as plain pi
 *
 * Throws when the requested/default profile does not exist.
 */
export function resolveLaunch(args: string[]): LaunchPlan {
	let name: string | undefined;
	const remaining: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === PROFILE_FLAG) {
			const value = args[i + 1];
			if (!value) {
				throw new Error("Error: --as expects a profile name. Use 'pipi profile list' to see available profiles.");
			}
			name = value;
			i++;
		} else if (arg.startsWith(PROFILE_FLAG + "=")) {
			name = arg.slice(PROFILE_FLAG.length + 1);
			if (!name) {
				throw new Error("Error: --as expects a profile name. Use 'pipi profile list' to see available profiles.");
			}
		} else {
			remaining.push(arg);
		}
	}

	if (name === undefined) {
		name = getDefaultProfileName(); // undefined when unset or built-in
	}

	if (name !== undefined) {
		if (!loadProfiles().profiles[name]) {
			throw unknownProfile(name);
		}
		return { kind: "profile", name, remainingArgs: remaining };
	}
	return { kind: "plain", remainingArgs: remaining };
}
