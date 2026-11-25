// The app kit's files on their own (`@earendil-works/chord/app/files`): `Files`, `FilesFolder`, their facet, copying a
// host's files and the kit's private directories and stores, for an app that hosts its own hosts without the rest of
// the kit (a worker process that must load neither esbuild nor the server's components).

export {
	type FileInfo,
	Files,
	type FilesCaps,
	FilesFolder,
	type FileWrite,
	type FolderEntry,
	type FolderInfo,
	type FolderListing,
	filesFacet,
	type SpaceSummary,
} from "./files.ts";
export { copyFiles } from "./files-copy.ts";
export { privateDirectory, privateStore } from "./layout.ts";
