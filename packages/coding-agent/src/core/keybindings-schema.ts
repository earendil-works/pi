import { type TSchema, Type } from "typebox";
import { KEYBINDINGS } from "./keybindings.ts";

const KeyIdSchema = Type.String();
const KeybindingValueSchema = Type.Union([KeyIdSchema, Type.Array(KeyIdSchema)]);
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
