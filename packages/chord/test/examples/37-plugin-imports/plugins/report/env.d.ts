// Types for the report plugin's imports that its directory does not hold: the app's host packages (an app ships their
// types with its plugin template) and its dependencies before `npm install` (their own types once installed).

declare module "@example/app" {
	const app: { readonly name: string; readonly version: number };
	export default app;
	export function currency(cents: number): string;
}

declare module "@example/legacy" {
	const legacy: { pad(text: string, width: number): string };
	export default legacy;
}

declare module "example-greeting" {
	export function greet(name: string): string;
}

declare module "example-native" {
	export function where(): string;
}
