#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isIdentifier,
	isImportDeclaration,
	isNamedExports,
	isNamedImports,
	isNoSubstitutionTemplateLiteral,
	isPropertyAccessExpression,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

// Packages without tsconfig.build.json are checked against a synthetic config.
const fallbackConfigName = "tsconfig.runtime-deps-fallback.json";
const fallbackConfig = JSON.stringify({ include: ["src/**/*"] });
const failures = [];

function checkSource(source, manifest) {
	const file = source.fileName;
	const declared = new Set([
		manifest.name,
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);

	function checkSpecifier(node) {
		if (!node || !(isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))) return;
		const specifier = node.text;
		// `cloudflare:` modules are built into the Workers runtime, like `node:` modules are into Node.
		if (
			specifier.startsWith(".") ||
			specifier.startsWith("/") ||
			specifier.startsWith("cloudflare:") ||
			isBuiltin(specifier)
		) {
			return;
		}
		const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		if (declared.has(name)) return;
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		failures.push(`${file}:${line + 1}: ${specifier} is not declared in ${manifest.name}'s runtime dependencies`);
	}

	function visit(node) {
		if (isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			if (
				!clause ||
				(clause.phaseModifier !== SyntaxKind.TypeKeyword &&
					(clause.name ||
						!bindings ||
						!isNamedImports(bindings) ||
						bindings.elements.length === 0 ||
						bindings.elements.some((element) => !element.isTypeOnly)))
			) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (isExportDeclaration(node) && !node.isTypeOnly) {
			const clause = node.exportClause;
			if (
				!clause ||
				!isNamedExports(clause) ||
				clause.elements.length === 0 ||
				clause.elements.some((element) => !element.isTypeOnly)
			) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (
			isCallExpression(node) &&
			(node.expression.kind === SyntaxKind.ImportKeyword ||
				(isIdentifier(node.expression) && node.expression.text === "require") ||
				(isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			checkSpecifier(node.arguments[0]);
		}
		node.forEachChild(visit);
	}
	visit(source);
}

const packages = getPublicWorkspacePackages()
	.map(({ directory }) => ({ directory, sourceDirectory: resolve(directory, "src") }))
	.filter(({ sourceDirectory }) => existsSync(sourceDirectory))
	.map(({ directory, sourceDirectory }) => {
		const configPath = resolve(directory, "tsconfig.build.json");
		return {
			sourceDirectory,
			manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
			configPath: existsSync(configPath) ? configPath : resolve(directory, fallbackConfigName),
		};
	});

const fallbackConfigs = new Set(
	packages.map(({ configPath }) => configPath).filter((path) => path.endsWith(fallbackConfigName)),
);
const api = new API({
	cwd: process.cwd(),
	fs: {
		fileExists: (fileName) => (fallbackConfigs.has(resolve(fileName)) ? true : undefined),
		readFile: (fileName) => (fallbackConfigs.has(resolve(fileName)) ? fallbackConfig : undefined),
	},
});
try {
	const snapshot = api.updateSnapshot({ openProjects: packages.map(({ configPath }) => configPath) });
	for (const { sourceDirectory, manifest, configPath } of packages) {
		const project = snapshot.getProject(configPath);
		const diagnostics = project.program.getConfigFileParsingDiagnostics();
		if (diagnostics.length > 0) throw new Error(diagnostics.map((diagnostic) => diagnostic.text).join("\n"));
		const roots = new Set(project.rootFiles.map((file) => resolve(file)));
		for (const fileName of project.program.getSourceFileNames()) {
			if (fileName.endsWith(".d.ts") || fileName.endsWith(".json")) continue;
			const path = relative(sourceDirectory, resolve(fileName));
			if (path.startsWith("..") || isAbsolute(path)) continue;
			// TypeScript's exclude only filters roots: imports can pull excluded files
			// back into the build. Reject that too, including type-only imports.
			if (!roots.has(resolve(fileName))) {
				failures.push(`${fileName} is excluded from ${manifest.name}'s build but imported by it`);
			}
			checkSource(project.program.getSourceFile(fileName), manifest);
		}
	}
} finally {
	api.close();
}

if (failures.length > 0) {
	console.error("Undeclared runtime imports in public packages:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Public package runtime imports have declared dependencies.");
