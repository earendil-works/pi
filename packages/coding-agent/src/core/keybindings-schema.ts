import { type TSchema, Type } from "typebox";
import { KeybindingValueSchema, keybindingValueSchema } from "./key-id-schema.ts";
import { KEYBINDINGS } from "./keybindings.ts";

export { KeybindingValueSchema } from "./key-id-schema.ts";

const properties: Record<string, TSchema> = {
	$schema: Type.Optional(Type.String()),
};

for (const [id, definition] of Object.entries(KEYBINDINGS)) {
	properties[id] = Type.Optional(
		keybindingValueSchema({
			description: definition.description,
		}),
	);
}

export const KeybindingsSchema = Type.Object(properties, {
	additionalProperties: KeybindingValueSchema,
});
