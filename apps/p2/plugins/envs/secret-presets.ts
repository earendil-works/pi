// Sandbox secret presets (browser-safe): the variable a tool reads, the hosts it sends it to, and what else helps the
// tool pick it up in the VM.

/** A secret's environment variable name in the VM. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** What helps tools in the VM pick a secret up: aliases (more variable names) and git's credential helper. */
export type SecretPreset = {
	readonly id: string;
	readonly label: string;
	readonly name: string;
	readonly hosts: readonly string[];
	/** Further variables set to the same placeholder (`GH_TOKEN` for `gh`). */
	readonly aliases?: readonly string[];
	/** Hosts git authenticates to with this secret (a credential helper set through `GIT_CONFIG_*`). */
	readonly gitHosts?: readonly string[];
	readonly hint: string;
};

export const SECRET_PRESETS: readonly SecretPreset[] = [
	{
		id: "github",
		label: "GitHub token",
		name: "GITHUB_TOKEN",
		hosts: ["github.com", "api.github.com", "uploads.github.com"],
		aliases: ["GH_TOKEN"],
		gitHosts: ["github.com"],
		hint: "git over HTTPS (a credential helper is set), gh (GH_TOKEN), the GitHub API. Use a fine-grained token.",
	},
	{
		id: "radius",
		label: "Radius token",
		name: "RADIUS_TOKEN",
		hosts: ["radius.earendil.com", "radius.pi.dev"],
		hint: 'Radius (artifacts at radius.earendil.com, the model gateway at radius.pi.dev): curl -H "Authorization: Bearer $RADIUS_TOKEN" …',
	},
	{
		id: "npm",
		label: "npm token",
		name: "NPM_TOKEN",
		hosts: ["registry.npmjs.org"],
		hint: `npm publish with //registry.npmjs.org/:_authToken=$${"{NPM_TOKEN}"} in .npmrc (a granular token).`,
	},
	{ id: "custom", label: "API key", name: "API_KEY", hosts: [], hint: "Any HTTP header: Authorization, X-Api-Key, …" },
];
