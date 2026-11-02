// Types of the API version this plugin was written against: the app no longer provides it (no module to type-check
// against, the build refuses the import), so the plugin's last author left these.

declare module "@acme/app/v1" {
	export function defineFacet(
		setup: (host: unknown, self: { contribute(registry: unknown, value: string): void }) => void,
	): unknown;
	export const Greetings: unknown;
}
