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
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
}
