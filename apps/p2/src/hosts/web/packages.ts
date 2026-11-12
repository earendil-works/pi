// The host packages of web facets (plugins.ts's web kind; main.tsx maps each to the page's module): what they import,
// the API's kind-neutral and web modules, React and the schema library. Browser-safe: the base bundle imports it.

/** The specifiers web facets import from the page, one instance each. */
export const WEB_PACKAGES = [
	"@p2/app/v1",
	"@p2/app/v1/web",
	"react",
	"react/jsx-runtime",
	"react-dom",
	"@earendil-works/pi-schema",
] as const;
