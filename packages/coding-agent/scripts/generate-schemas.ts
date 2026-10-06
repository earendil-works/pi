#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelPromptCacheSchema,
	ModelThinkingLevelSchema,
	ThinkingLevelMapSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import type { TSchema } from "typebox";
import { KeybindingsSchema, KeybindingValueSchema } from "../src/core/keybindings-schema.ts";
import { ModelsConfigSchema } from "../src/core/model-config.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { ColorValueSchema, ThemeJsonSchema } from "../src/modes/interactive/theme/theme-schema.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const schemaBaseUrl = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent";
const schemaDraft = "https://json-schema.org/draft/2020-12/schema";
const generatedComment =
	"This file is generated from TypeScript source. Do not edit it manually; run npm run generate:schemas.";

interface SchemaArtifact {
	path: `schemas/${string}.schema.json`;
	schema: TSchema;
	definitions?: Readonly<Record<string, TSchema>>;
}

const schemaArtifacts: readonly SchemaArtifact[] = [
	{
		path: "schemas/models.schema.json",
		schema: ModelsConfigSchema,
		definitions: {
			ModelCost: ModelCostSchema,
			ModelInputLimits: ModelInputLimitsSchema,
			ModelPromptCache: ModelPromptCacheSchema,
			ProviderCompat: ProviderCompatSchema,
			ThinkingLevelMap: ThinkingLevelMapSchema,
		},
	},
	{
		path: "schemas/settings.schema.json",
		schema: SettingsSchema,
		definitions: { ModelThinkingLevel: ModelThinkingLevelSchema },
	},
	{
		path: "schemas/keybindings.schema.json",
		schema: KeybindingsSchema,
		definitions: { KeybindingValue: KeybindingValueSchema },
	},
	{
		path: "schemas/theme.schema.json",
		schema: ThemeJsonSchema,
		definitions: { ColorValue: ColorValueSchema },
	},
];

const schemaAnnotationKeys = new Set([
	"default",
	"deprecated",
	"description",
	"examples",
	"readOnly",
	"title",
	"writeOnly",
]);

function splitAnnotations(schema: object): {
	shape: Record<string, unknown>;
	annotations: Record<string, unknown>;
} {
	const shape: Record<string, unknown> = {};
	const annotations: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		(schemaAnnotationKeys.has(key) ? annotations : shape)[key] = value;
	}
	return { shape, annotations };
}

/** Replace selected repeated schemas with local references while retaining per-use annotations. */
function addDefinitions(schema: TSchema, definitions: Readonly<Record<string, TSchema>>): TSchema {
	const preparedDefinitions = Object.entries(definitions).map(([name, definition]) => {
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
			throw new Error(`Invalid schema definition name: ${name}`);
		}
		const { shape } = splitAnnotations(definition);
		return { name, shape, shapeKey: JSON.stringify(shape) };
	});

	const referencedDefinitions = new Set<string>();
	const replaceDefinitions = (value: unknown, excludedName?: string): unknown => {
		if (Array.isArray(value)) return value.map((item) => replaceDefinitions(item, excludedName));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

		const { shape, annotations } = splitAnnotations(value);
		const shapeKey = JSON.stringify(shape);
		const match = preparedDefinitions.find(
			(definition) => definition.name !== excludedName && definition.shapeKey === shapeKey,
		);
		if (match) {
			referencedDefinitions.add(match.name);
			return { $ref: `#/$defs/${match.name}`, ...annotations };
		}

		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				schemaAnnotationKeys.has(key) ? child : replaceDefinitions(child, excludedName),
			]),
		);
	};

	const compactSchema = replaceDefinitions(schema) as TSchema;
	const compactDefinitions = Object.fromEntries(
		preparedDefinitions.map(({ name, shape }) => [name, replaceDefinitions(shape, name)]),
	);
	const unusedDefinitions = preparedDefinitions
		.map(({ name }) => name)
		.filter((name) => !referencedDefinitions.has(name));
	if (unusedDefinitions.length > 0) {
		throw new Error(`Unused schema definitions: ${unusedDefinitions.join(", ")}`);
	}
	return { ...compactSchema, $defs: compactDefinitions };
}

function serializeSchema(artifact: SchemaArtifact): string {
	const schema = artifact.definitions ? addDefinitions(artifact.schema, artifact.definitions) : artifact.schema;
	return `${JSON.stringify(
		{
			$schema: schemaDraft,
			$id: `${schemaBaseUrl}/${artifact.path}`,
			$comment: generatedComment,
			...schema,
		},
		null,
		2,
	)}\n`;
}

export function renderConfigSchemas(): ReadonlyMap<string, string> {
	const rendered = new Map<string, string>();
	for (const artifact of schemaArtifacts) {
		const content = serializeSchema(artifact);
		rendered.set(artifact.path, content);
	}
	return rendered;
}

function generateSchemas(): void {
	for (const [relativePath, content] of renderConfigSchemas()) {
		const path = resolve(packageDirectory, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf-8");
		console.log(`Generated packages/coding-agent/${relativePath}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	generateSchemas();
}
