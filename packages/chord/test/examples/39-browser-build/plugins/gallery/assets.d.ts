// Types for what a browser build imports besides code: a stylesheet (collected into the build's one CSS file) and an
// asset by URL (`./file.svg?url`: the URL the app serves it under, as a string).

declare module "*.css" {}

declare module "*?url" {
	const url: string;
	export default url;
}
