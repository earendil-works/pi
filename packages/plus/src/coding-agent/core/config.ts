/**
 * Wrapper for packages/coding-agent/src/config.ts.
 *
 * Pass-through except APP_NAME/APP_TITLE: the plus CLI identifies as "pipi"
 * (pi-plus) in CLI text, while the terminal tab title brands as "pi+".
 * Scope is the display name only — everything upstream derives
 * internally from its own module-local constants keeps pi naming (config dir
 * ".pi", PI_-prefixed env vars, debug log path), so plus shares pi's config
 * and session layout.
 *
 * Also shadows the package-asset directory getters: the compiled pi-plus bundle
 * (packages/plus/dist/npm/) ships its assets directly in the package root
 * (modes/, core/) rather than in a src/ or dist/ tree, so upstream's
 * src-or-dist detection cannot find them. Source-mode runs (./pipi) keep the
 * upstream implementations.
 */
export * from "../../../../coding-agent/src/config.ts";

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	getPackageDir,
	getExportTemplateDir as upstreamGetExportTemplateDir,
	getInteractiveAssetsDir as upstreamGetInteractiveAssetsDir,
	getThemesDir as upstreamGetThemesDir,
} from "../../../../coding-agent/src/config.ts";

export const APP_NAME: string = "pipi";
export const APP_TITLE: string = "pi+";

/** True when running from the staged bundle, whose package root has neither src/ nor dist/. */
function isStagedBundle(): boolean {
	const packageDir = getPackageDir();
	return !existsSync(join(packageDir, "src")) && !existsSync(join(packageDir, "dist"));
}

export function getThemesDir(): string {
	if (isStagedBundle()) return join(getPackageDir(), "modes", "interactive", "theme");
	return upstreamGetThemesDir();
}

export function getExportTemplateDir(): string {
	if (isStagedBundle()) return join(getPackageDir(), "core", "export-html");
	return upstreamGetExportTemplateDir();
}

export function getInteractiveAssetsDir(): string {
	if (isStagedBundle()) return join(getPackageDir(), "modes", "interactive", "assets");
	return upstreamGetInteractiveAssetsDir();
}

// Must be shadowed too: upstream's own getBundledInteractiveAssetPath binds the
// upstream getInteractiveAssetsDir, bypassing the shadow above.
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}
