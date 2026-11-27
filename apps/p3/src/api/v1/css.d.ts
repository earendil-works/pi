// What a web facet's stylesheet and asset imports are to TypeScript: a plain stylesheet is imported for its effect, a
// CSS module (`*.module.css`) gives its class names, an asset by URL (`?url`) its address. Referenced by `web.ts`, so
// a plugin importing `/v1/web` has them.

declare module "*.module.css" {
	const classes: Readonly<Record<string, string>>;
	export default classes;
}

declare module "*.css";

// A web facet's asset imported by URL (`./vendor/x.wasm?url`): the URL the page fetches it from.
declare module "*?url" {
	const url: string;
	export default url;
}
