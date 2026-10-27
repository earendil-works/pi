export interface ContentAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

export interface TextContent {
	type: "text";
	text: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface AudioContent {
	type: "audio";
	data: string;
	mimeType: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface ResourceLinkContent {
	type: "resource_link";
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface TextResourceContents {
	uri: string;
	mimeType?: string;
	text: string;
	_meta?: Record<string, unknown>;
}

export interface BlobResourceContents {
	uri: string;
	mimeType?: string;
	blob: string;
	_meta?: Record<string, unknown>;
}

export interface EmbeddedResourceContent {
	type: "resource";
	resource: TextResourceContents | BlobResourceContents;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddedResourceContent;

export interface CallToolResult {
	content: ContentBlock[];
	/** Any JSON value, including arrays and `null` (MCP 2026-07-28; earlier revisions allowed only objects). */
	structuredContent?: unknown;
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

/**
 * Tool result content in the shape LLM APIs accept: text and base64 images. Matches the
 * `TextContent` and `ImageContent` types of `@earendil-works/pi-ai`.
 */
export type LlmContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function blockToLlmContent(block: ContentBlock): LlmContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		case "resource_link":
			return { type: "text", text: `${block.name}: ${block.uri}` };
		case "resource": {
			const resource = block.resource;
			if ("text" in resource) return { type: "text", text: resource.text };
			if (resource.mimeType?.startsWith("image/")) {
				return { type: "image", data: resource.blob, mimeType: resource.mimeType };
			}
			return {
				type: "text",
				text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]`,
			};
		}
		default:
			return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
	}
}

/**
 * Convert a tool result to text and image content for a model. Text and images pass through,
 * embedded text resources become text, embedded image resources become images, and other blocks
 * (audio, resource links, binary resources) become a short text placeholder. A result without
 * content blocks but with `structuredContent` becomes its JSON, since servers should, but do not
 * always, mirror structured results as text.
 */
export function toLlmContent(result: Pick<CallToolResult, "content" | "structuredContent">): LlmContent[] {
	const content = (result.content ?? []).map(blockToLlmContent);
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	return content;
}
