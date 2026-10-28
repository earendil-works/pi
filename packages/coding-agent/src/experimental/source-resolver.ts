import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node strips TypeScript natively, but it does not apply the workspace source
// aliases from tsconfig.json. Internal source processes preload this resolver so
// they cannot silently fall through to stale package dist files.

interface TsConfig {
	readonly compilerOptions?: {
		readonly paths?: Readonly<Record<string, readonly string[]>>;
	};
}

interface SourceAlias {
	readonly pattern: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly replacements: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const tsconfigPath = resolve(repositoryRoot, "tsconfig.json");
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsConfig;
const paths = tsconfig.compilerOptions?.paths;
if (!paths) throw new Error(`Source runtime requires compilerOptions.paths in ${tsconfigPath}`);

const aliases: SourceAlias[] = Object.entries(paths)
	.filter(([pattern]) => pattern.startsWith("@earendil-works/"))
	.map(([pattern, replacements]) => {
		const wildcard = pattern.indexOf("*");
		if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
			throw new Error(`Source runtime does not support multiple wildcards in ${pattern}`);
		}
		return {
			pattern,
			prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
			suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
			replacements,
		};
	})
	.sort((left, right) => right.pattern.length - left.pattern.length);

registerHooks({
	resolve(specifier, context, nextResolve) {
		let matchedPattern: string | undefined;
		for (const alias of aliases) {
			const wildcard = matchAlias(alias, specifier);
			if (wildcard === undefined) continue;
			matchedPattern ??= alias.pattern;
			for (const replacement of alias.replacements) {
				const resolved = resolveSourcePath(replacement.replace("*", wildcard));
				if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
			}
		}
		if (matchedPattern) {
			throw new Error(`Source runtime could not resolve ${specifier} through tsconfig path ${matchedPattern}`);
		}
		return nextResolve(specifier, context);
	},
});

function matchAlias(alias: SourceAlias, specifier: string): string | undefined {
	if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
	if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
	return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

function resolveSourcePath(replacement: string): string | undefined {
	const basePath = resolve(repositoryRoot, replacement);
	const rootPrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;
	if (!basePath.startsWith(rootPrefix)) return undefined;
	const extension = extname(basePath);
	const sourceExtension =
		extension === ".js" ? ".ts" : extension === ".mjs" ? ".mts" : extension === ".cjs" ? ".cts" : undefined;
	const candidates = sourceExtension
		? [basePath, `${basePath.slice(0, -extension.length)}${sourceExtension}`]
		: extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".json"
			? [basePath]
			: [basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}
