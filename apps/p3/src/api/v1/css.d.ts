// What a web facet's stylesheet imports are to TypeScript: a plain stylesheet is imported for its effect, a CSS
// module (`*.module.css`) gives its class names. Referenced by `web.ts`, so a plugin importing `/v1/web` has them.

declare module "*.module.css" {
	const classes: Readonly<Record<string, string>>;
	export default classes;
}

declare module "*.css";
