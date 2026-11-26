// The files plugin's texts people see: its ticks' labels (decision 65), as the things plugin's Settings view shows
// them, what a refused call says, and the Files pane's labels. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The files plugin's messages, by key. */
export const messages = defineMessages("files", {
	en: {
		tickBrowse: "Browse",
		tickEdit: "Edit",
		notAbsolute: "A path starts at the machine's root (/).",
		notFound: "This file or folder does not exist.",
		hidden: "Pi's own data folder is not shown, and nothing that holds it is changed.",
		root: "The machine's root folder cannot be removed or moved.",
		failed: (reason: string) => `The machine refused: ${reason}`,
		pane: "Files",
		up: "Up",
		search: "Search",
		searchHere: "Search in this folder",
		clearSearch: "Back to the folder",
		upload: "Upload",
		download: "Download",
		rename: "Rename",
		remove: "Remove",
		save: "Save",
		cancel: "Cancel",
		empty: "This folder is empty.",
		noHits: "Nothing found.",
		truncated: "More was found than is shown.",
		more: "More",
		loading: "Loading…",
		denied: "You may not browse files here.",
		unavailable: "Files cannot be shown now.",
		uploading: (name: string) => `Uploading ${name}…`,
		uploadFailed: (status: number) => `The upload failed (${status}).`,
	},
});
