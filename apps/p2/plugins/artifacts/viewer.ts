// The artifacts plugin's viewer layer: the route layer that shows an artifact version or a file over the chat, written
// by the cards, the side panel's list and the command menu, read back from the route by the chat's content slot.
import { compile, obj, union } from "@earendil-works/pi-schema";
import { literal } from "@p2/app/v1";
import type { Layer, ViewerItem } from "@p2/app/v1/web";
import { DownloadInfoSchema } from "../files/contract.ts";
import { ArtifactInfoSchema } from "./contract.ts";

/** The layer showing `item`. */
export const viewerLayer = (item: ViewerItem): Layer => ({
	kind: "viewer",
	name: "artifacts",
	locator: `viewer:${JSON.stringify(item)}`,
});

/** The item the route's top layer shows, when it is this plugin's viewer. */
export function viewerItem(top: Layer | undefined): ViewerItem | undefined {
	return top?.kind === "viewer" && top.name === "artifacts" ? parse(top.locator) : undefined;
}

const ViewerSchema = union([
	obj({ kind: literal("file"), file: DownloadInfoSchema }, { open: true }),
	obj({ kind: literal("artifact"), artifact: ArtifactInfoSchema }, { open: true }),
]);
const isViewer = compile(ViewerSchema).check;

/** Untrusted URL metadata is only a locator. HTTP routes authorize every content fetch. */
function parse(locator: string | undefined): ViewerItem | undefined {
	if (!locator?.startsWith("viewer:")) return undefined;
	try {
		const value: unknown = JSON.parse(locator.slice("viewer:".length));
		return isViewer(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
