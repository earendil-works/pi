export const FACET_BUNDLE_FORMAT = "chord.facet-bundle";
export const FACET_BUNDLE_FORMAT_VERSION = 2;
export const FACET_BUNDLE_MANIFEST_FILE = "chord-facets.json";
export const FACET_BUNDLE_ARTIFACT_FORMAT = "chord.facet-bundle-artifact";
export const FACET_BUNDLE_ARTIFACT_FORMAT_VERSION = 2;

export interface FacetBundleEntry {
	/** Content-addressed CommonJS filename relative to the manifest. */
	readonly file: string;
	/** SHA-256 subresource-integrity value for the JavaScript file. */
	readonly integrity: string;
	/** Imports intentionally left for the loading application to resolve. */
	readonly externalImports: readonly string[];
	/** Source map filename relative to the manifest, when emitted. */
	readonly sourceMap?: string;
}

export interface FacetBundleManifest {
	readonly format: typeof FACET_BUNDLE_FORMAT;
	readonly formatVersion: typeof FACET_BUNDLE_FORMAT_VERSION;
	readonly plugin: FacetBundlePlugin;
	readonly entries: Readonly<Record<string, FacetBundleEntry>>;
}

export interface FacetBundlePlugin {
	readonly id: string;
	readonly version?: string;
}

/** One self-contained manifest entry suitable for storage or transport to another Node host. */
export interface FacetBundleArtifact {
	readonly format: typeof FACET_BUNDLE_ARTIFACT_FORMAT;
	readonly formatVersion: typeof FACET_BUNDLE_ARTIFACT_FORMAT_VERSION;
	readonly plugin: FacetBundlePlugin;
	readonly entryName: string;
	readonly entry: FacetBundleEntry;
	readonly source: string;
	readonly sourceMapContents?: string;
}
