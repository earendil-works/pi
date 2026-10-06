import { Key } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { KEYBINDINGS } from "./keybindings.ts";

const modifiers = ["ctrl", "shift", "alt", "super"] as const;
const baseKeyPattern = `(?:[a-z0-9]|${Object.values(Key)
	.flatMap((value) => (typeof value === "string" ? [value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")] : []))
	.join("|")})`;
const duplicateModifierPattern = modifiers.map((modifier) => `${modifier}\\+.*${modifier}\\+`).join("|");
const KeyIdSchema = Type.String({
	pattern: `^(?!.*(?:${duplicateModifierPattern}))(?:(?:${modifiers.join("|")})\\+){0,4}${baseKeyPattern}$`,
	description: "Key identifier with optional ctrl, shift, alt, or super modifiers.",
});
export const KeybindingValueSchema = Type.Union([KeyIdSchema, Type.Array(KeyIdSchema)]);
const properties: Record<string, TSchema> = {
	$schema: Type.Optional(Type.String()),
};

for (const [id, definition] of Object.entries(KEYBINDINGS)) {
	properties[id] = Type.Optional(
		Type.Union([KeyIdSchema, Type.Array(KeyIdSchema)], {
			description: definition.description,
		}),
	);
}

export const KeybindingsSchema = Type.Object(properties, {
	additionalProperties: KeybindingValueSchema,
});
