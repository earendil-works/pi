// Schemas several plugins' contracts share (browser-safe). A contract imports only the API and its own plugin's files,
// so what two contracts both use lives here: attachments (files, chat), model references and thinking levels (sessions,
// chat), pages of a conversation's entries (chat, the clients' transcripts) and directory listings (envs, locations).

import type { EntryRecord } from "@earendil-works/pi-durable";
import { arr, bool, int, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { literal, unsafe } from "./schema.ts";

/**
 * An attachment of a message: an upload of the session (its `Files`, space `uploads`) as written to the machine where
 * the receiving conversation works (`path`), never into the project.
 */
export const AttachmentSchema = obj({
	id: str(),
	name: str(),
	path: str(),
	/** Local upload copy, retained for inline images when path points to the remote host. */
	localPath: opt(str()),
	size: num(),
	mimeType: opt(str()),
});
export type Attachment = Static<typeof AttachmentSchema>;

/** At most this many attachments per message. */
export const MAX_ATTACHMENTS = 20;

export const ModelRefSchema = obj({
	provider: str({ minLength: 1 }),
	modelId: str({ minLength: 1 }),
});

/** Thinking levels a session or conversation may ask for (clamped to the model when it runs), as Pi Mobile accepts. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/**
 * A string enum (pi-ai's `StringEnum` shape), validated wherever a thinking level is set. Its static type stays
 * `string`, so callers that hold a level as a string (pickers, the TUI) need no casts; the value is checked at the call.
 */
export const ThinkingLevelSchema = unsafe<string>({ type: "string", enum: [...THINKING_LEVELS] });
export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
	typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

/** At most this many entries per `Chat.entries` page (a page is also cut at about 1 MB of entries). */
export const MAX_ENTRIES_PAGE = 200;

/** A page of a conversation's entries (`Conversation.entries()`), for `ConversationTranscript`'s loader. */
export const EntriesQuerySchema = obj({
	/** Oldest entry ID that may be returned. */
	minEntryId: opt(int({ minimum: 0 })),
	/** Newest entry ID that may be returned. */
	maxEntryId: opt(int({ minimum: 0 })),
	/** Default `descending` (newest first). */
	order: opt(union([literal("ascending"), literal("descending")])),
	limit: int({ minimum: 1, maximum: MAX_ENTRIES_PAGE }),
});
export const EntriesPageSchema = obj({
	/** Durable entry records in the query's order. */
	items: unsafe<EntryRecord[]>(arr(unknown())),
	/** More entries match the query: the page was full, or cut at its byte bound. */
	more: bool(),
});
export type EntriesPage = Static<typeof EntriesPageSchema>;

/** The folders of a directory (this device's or an environment's), for the directory pickers and `location_dirs`. */
export const DirectoryListingSchema = obj({
	path: str(),
	parent: union([str(), nul()]),
	directories: arr(str()),
	truncated: bool(),
});
export type DirectoryListing = Static<typeof DirectoryListingSchema>;
