// Resolve workspace packages to their TypeScript sources, so the triage tool runs without building packages.
// A package without a "source" export condition (pi-ai) resolves to dist/*.js; this maps it to src/*.ts.
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST_JS = /(\/(?:packages|node_modules\/@earendil-works)\/[^/]+)\/dist\/(.+)\.js$/;

function toSource(url) {
	if (!url?.startsWith("file:")) return undefined;
	const path = fileURLToPath(url);
	if (path.includes("/node_modules/") && !path.includes("/node_modules/@earendil-works/")) return undefined;
	if (!DIST_JS.test(path)) return undefined;
	const source = path.replace(DIST_JS, "$1/src/$2.ts");
	if (!existsSync(source)) return undefined;
	// Real path: Node refuses to strip types under node_modules.
	return pathToFileURL(realpathSync(source)).href;
}

export async function resolve(specifier, context, nextResolve) {
	let result;
	try {
		result = await nextResolve(specifier, context);
	} catch (error) {
		const source = toSource(error?.url);
		if (source) return { url: source, format: "module-typescript", shortCircuit: true };
		throw error;
	}
	const source = toSource(result.url);
	return source ? { url: source, format: "module-typescript", shortCircuit: true } : result;
}
