#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import { ModelInputLimitsSchema } from "@earendil-works/pi-ai/providers/model-schema";
import type { TSchema } from "typebox";
import { ModelsJsonSchemas } from "../src/core/model-config.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const generatedComment =
	"This file is generated from TypeScript source. Do not edit it manually; run npm run generate:references.";

/** The subset of JSON Schema that reference pages render. */
interface ReferenceSchema {
	type?: string;
	const?: unknown;
	enum?: readonly unknown[];
	anyOf?: readonly ReferenceSchema[];
	items?: ReferenceSchema;
	properties?: Readonly<Record<string, ReferenceSchema>>;
	required?: readonly string[];
	description?: string;
	default?: unknown;
}

interface ReferenceSection {
	heading: string;
	intro?: string;
	/** Object schema whose properties become table rows. */
	schema?: TSchema;
	/** Top-level fields whose type links to another section instead of listing nested fields. */
	links?: Readonly<Record<string, string>>;
	/** Top-level fields listed without their nested fields. */
	collapsed?: readonly string[];
}

interface ReferenceArtifact {
	path: `docs/${string}.md`;
	title: string;
	intro: string;
	sections: readonly ReferenceSection[];
}

/** APIs grouped by the compatibility schema they share, in first-seen order. */
const compatSchemaApis = new Map<TSchema, string[]>();
for (const [api, schema] of Object.entries(CompatSchemasByApi)) {
	compatSchemaApis.set(schema, [...(compatSchemaApis.get(schema) ?? []), api]);
}

const formatList = (items: readonly string[]) =>
	items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");

const referenceArtifacts: readonly ReferenceArtifact[] = [
	{
		path: "docs/models-configuration.md",
		title: "Models Configuration",
		intro: [
			"This reference lists the fields of `models.json`. See [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint) for examples and [Configuration](configuration.md#agent-directory) for the file location.",
			'Add `"$schema": "https://pi.dev/schemas/models.schema.json"` to `models.json` for editor validation and completion.',
		].join("\n\n"),
		sections: [
			{
				heading: "Providers",
				intro: "Each key under `providers` is a provider ID. A built-in provider ID changes that provider. Any other ID adds a provider, which needs `baseUrl` and an `api` at provider or model level.",
				schema: ModelsJsonSchemas.provider,
				links: { models: "#models", modelOverrides: "#model-overrides", compat: "#compatibility" },
			},
			{
				heading: "Models",
				intro: "Each `models` entry adds a model to the provider. An entry whose `id` matches an existing model replaces it.",
				schema: ModelsJsonSchemas.model,
				links: { inputLimits: "#input-limits", compat: "#compatibility" },
			},
			{
				heading: "Model overrides",
				intro: "Each `modelOverrides` key is the ID of a built-in or extension model. Unknown IDs are ignored. Object fields, such as `cost`, merge with the model's value field by field; other fields replace it.",
				schema: ModelsJsonSchemas.modelOverride,
				links: { inputLimits: "#input-limits", compat: "#compatibility" },
			},
			{
				heading: "Input limits",
				intro: "See [Describe model input and caching](models.md#describe-model-input-and-caching).",
				schema: ModelInputLimitsSchema,
			},
			{
				heading: "Compatibility",
				intro: "`compat` describes verified differences from an API's standard request and response behavior. Model values override provider values per field. The fields that apply depend on the model's `api`.",
			},
			...[...compatSchemaApis].map(([schema, [api, ...aliases]]) => ({
				heading: `### \`${api}\``,
				intro: aliases.length > 0 ? `Also applies to ${formatList(aliases.map((alias) => `\`${alias}\``))}.` : undefined,
				schema,
				collapsed: ["openRouterRouting", "vercelGatewayRouting"],
			})),
		],
	},
];

function referenceType(schema: ReferenceSchema): string {
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	if (schema.anyOf) return [...new Set(schema.anyOf.map(referenceType))].join(" | ");
	if (schema.type === "array") {
		const item = schema.items ? referenceType(schema.items) : "unknown";
		return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
	}
	return schema.type ?? "unknown";
}

/** Nested object whose fields get their own rows, if any of them carry documentation. */
function documentedObject(schema: ReferenceSchema): { suffix: string; schema: ReferenceSchema } | undefined {
	if (schema.type === "array") {
		const item = schema.items && documentedObject(schema.items);
		return item && { suffix: `[]${item.suffix}`, schema: item.schema };
	}
	const object = schema.properties ? schema : schema.anyOf?.find((branch) => branch.properties);
	const documented = Object.values(object?.properties ?? {}).some(
		(field) => field.description !== undefined || field.default !== undefined,
	);
	return object && documented ? { suffix: "", schema: object } : undefined;
}

const escapeTableText = (text: string) => text.replaceAll("|", "\\|").replaceAll("<", "&lt;");

function referenceRows(schema: ReferenceSchema, section: ReferenceSection, prefix = ""): string[] {
	const rows: string[] = [];
	for (const [name, field] of Object.entries(schema.properties ?? {})) {
		const path = `${prefix}${name}`;
		const link = prefix === "" ? section.links?.[name] : undefined;
		const type = escapeTableText(referenceType(field));
		const typeText = /^[a-z]+$/.test(type) ? type : `\`${type}\``;
		const defaultText = field.default === undefined ? "" : `\`${escapeTableText(JSON.stringify(field.default))}\``;
		const description = [schema.required?.includes(name) ? "Required." : undefined, field.description]
			.filter((text) => text !== undefined)
			.join(" ");
		rows.push(
			`| \`${path}\` | ${link ? `[${typeText}](${link})` : typeText} | ${defaultText} | ${escapeTableText(description)} |`,
		);
		if (link || (prefix === "" && section.collapsed?.includes(name))) continue;
		const nested = documentedObject(field);
		if (nested) rows.push(...referenceRows(nested.schema, section, `${path}${nested.suffix}.`));
	}
	return rows;
}

function renderReference(artifact: ReferenceArtifact): string {
	const blocks = [`# ${artifact.title}`, `<!-- ${generatedComment} -->`, artifact.intro];
	for (const section of artifact.sections) {
		blocks.push(section.heading.startsWith("#") ? section.heading : `## ${section.heading}`);
		if (section.intro) blocks.push(section.intro);
		if (section.schema) {
			const rows = referenceRows(section.schema as ReferenceSchema, section);
			blocks.push(["| Field | Type | Default | Description |", "|---|---|---|---|", ...rows].join("\n"));
		}
	}
	return `${blocks.join("\n\n")}\n`;
}

export function renderReferences(): ReadonlyMap<string, string> {
	return new Map(referenceArtifacts.map((artifact) => [artifact.path, renderReference(artifact)]));
}


function generateReferences(): void {
	for (const [relativePath, content] of renderReferences()) {
		const path = resolve(packageDirectory, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf-8");
		console.log(`Generated packages/coding-agent/${relativePath}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	generateReferences();
}
