// Shared wire contracts for isolated PDF, web, and SQLite reads.
import { type Static, Type } from "typebox";
import { ProjectBrowserConnectionSchema } from "./browser-protocol.ts";

export const readerArguments = {
	pages: Type.Optional(
		Type.String({ description: "PDF pages, 1-indexed: e.g. 3-5,8. Default: all text pages, or page 1 for images." }),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("images")], {
			description: "PDF: text or images. URL: markdown (default) or text.",
		}),
	),
	strategy: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("browser")], {
			description:
				"URLs only. browser explicitly uses installed Chromium with a persistent Pi-owned project profile; never your personal browser or a downloaded browser.",
		}),
	),
	table: Type.Optional(
		Type.String({
			minLength: 1,
			description: "SQLite table or view to inspect; omit table/query for a schema overview.",
		}),
	),
	query: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 100_000,
			description:
				"One read-only SQLite SELECT or WITH query. Writes, attachment, and extension loading are prohibited.",
		}),
	),
	params: Type.Optional(
		Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), {
			maxItems: 128,
			description: "Positional SQLite query parameters for ? placeholders.",
		}),
	),
	rowOffset: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER - 1000,
			description: "SQLite result row offset, 0-indexed (default 0).",
		}),
	),
	rowLimit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1000,
			description: "SQLite returned row limit (default 100, maximum 1000). Follow nextRowOffset.",
		}),
	),
};

export const ReaderRequestSchema = Type.Object(
	{
		path: Type.String(),
		...readerArguments,
		browserExecutablePath: Type.Optional(Type.String()),
		browserProjectDir: Type.Optional(Type.String()),
		browserConnection: Type.Optional(ProjectBrowserConnectionSchema),
		pdfiumWasmPath: Type.String(),
		data: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ReaderRequest = Static<typeof ReaderRequestSchema>;

const ImageSchema = Type.Object({
	page: Type.Integer(),
	width: Type.Number(),
	height: Type.Number(),
	data: Type.String(),
	mimeType: Type.Literal("image/png"),
});
export const ReaderSourceSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("pdf"),
		path: Type.String(),
		pageCount: Type.Integer(),
		pages: Type.Array(Type.Integer()),
		finalUrl: Type.Optional(Type.String()),
	}),
	Type.Object({
		kind: Type.Literal("web"),
		url: Type.String(),
		finalUrl: Type.String(),
		strategy: Type.String(),
		title: Type.String(),
		statusCode: Type.Integer(),
		contentType: Type.String(),
	}),
	Type.Object({
		kind: Type.Literal("sqlite"),
		path: Type.String(),
		table: Type.Optional(Type.String()),
		rowOffset: Type.Optional(Type.Integer()),
		rowLimit: Type.Optional(Type.Integer()),
		nextRowOffset: Type.Optional(Type.Integer()),
	}),
]);
export type ReaderSource = Static<typeof ReaderSourceSchema>;
export const ReaderResultSchema = Type.Object({
	status: Type.Union([Type.Literal("ok"), Type.Literal("partial"), Type.Literal("unreadable")]),
	text: Type.String(),
	images: Type.Array(ImageSchema),
	source: ReaderSourceSchema,
});
export type ReaderResult = Static<typeof ReaderResultSchema>;
export const ReaderResponseSchema = Type.Union([
	Type.Object({ ok: Type.Literal(true), result: ReaderResultSchema }),
	Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);
export type ReaderResponse = Static<typeof ReaderResponseSchema>;
export const MAX_READER_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_READER_INPUT_BYTES = 64 * 1024 * 1024;
