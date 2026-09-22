#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { KeybindingsSchema } from "../src/core/keybindings-schema.ts";
import { ModelsConfigSchema } from "../src/core/model-config.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { ThemeJsonSchema } from "../src/modes/interactive/theme/theme-schema.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const schemaBaseUrl = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent";
const schemaDraft = "https://json-schema.org/draft/2020-12/schema";
const generatedComment =
	"This file is generated from TypeScript source. Do not edit it manually; run npm run generate:schemas.";

interface SchemaArtifact {
	path: `schemas/${string}.schema.json`;
	schema: TSchema;
}

const schemaArtifacts: readonly SchemaArtifact[] = [
	{ path: "schemas/models.schema.json", schema: ModelsConfigSchema },
	{ path: "schemas/settings.schema.json", schema: SettingsSchema },
	{ path: "schemas/keybindings.schema.json", schema: KeybindingsSchema },
	{ path: "schemas/theme.schema.json", schema: ThemeJsonSchema },
];

function serializeSchema(artifact: SchemaArtifact): string {
	return `${JSON.stringify(
		{
			$schema: schemaDraft,
			$id: `${schemaBaseUrl}/${artifact.path}`,
			$comment: generatedComment,
			...artifact.schema,
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
