// Results a turn made for the person, read from tool details and validated: artifact versions, sent files and
// opened ports (only Radius forward addresses).
import type { ArtifactInfo } from "../../runtime/schemas.ts";
import type { ToolView } from "../transcript.ts";

const str = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** An artifact's details, when they are a complete, valid version. */
export function artifactOf(tool: ToolView): ArtifactInfo | undefined {
	const details = record(tool.details);
	return tool.status === "done" &&
		typeof details.name === "string" &&
		/^[a-z0-9][a-z0-9_-]{0,63}$/.test(details.name) &&
		typeof details.title === "string" &&
		["html", "svg", "markdown", "text"].includes(String(details.type)) &&
		typeof details.version === "number" &&
		Number.isSafeInteger(details.version) &&
		details.version > 0
		? // The version this call produced, without the details' `inline` flag (the viewer's locator is closed).
			{
				name: details.name,
				title: details.title,
				type: details.type as ArtifactInfo["type"],
				version: details.version,
			}
		: undefined;
}

/** Whether the agent asked for an artifact to show in the chat itself, not only as a card. */
export const shownInline = (tool: ToolView): boolean => record(tool.details).inline === true;

/** A sent file's details, when complete and valid. */
export function sentFileOf(tool: ToolView): { id: string; name: string; size: number } | undefined {
	const details = record(tool.details);
	return tool.status === "done" &&
		typeof details.id === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(details.id) &&
		typeof details.name === "string" &&
		typeof details.size === "number" &&
		details.size >= 0
		? { id: details.id, name: details.name, size: details.size }
		: undefined;
}

/** The addresses of a port a call opened: private, and public when it is public. Only Radius forward addresses. */
export function forwardOf(tool: ToolView): { name: string; url?: string; publicUrl?: string } | undefined {
	const forward = record(record(tool.details).forward);
	const link = (value: unknown) =>
		typeof value === "string" && /^https?:\/\/(?:fwd|pub)--[0-9a-f]{32}--[a-z0-9]+\.[^/\s]+\/$/.test(value)
			? value
			: undefined;
	const url = link(forward.url);
	const publicUrl = link(forward.publicUrl);
	if (tool.status !== "done" || !(url || publicUrl)) return undefined;
	return {
		name: str(forward.name) || `port ${typeof forward.port === "number" ? forward.port : str(forward.port)}`,
		...(url ? { url } : {}),
		...(publicUrl ? { publicUrl } : {}),
	};
}
