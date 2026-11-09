// Validated local display/input protocol; conversation state stays in the owning pi process.
import { type Static, Type } from "typebox";

const dimensions = {
	columns: Type.Integer({ minimum: 1, maximum: 1000 }),
	rows: Type.Integer({ minimum: 1, maximum: 500 }),
};

export const PaneCredentialsSchema = Type.Object({
	port: Type.Integer({ minimum: 1, maximum: 65535 }),
	token: Type.String({ minLength: 64, maxLength: 64 }),
});

export const PaneInputSchema = Type.Union([
	Type.Object({ type: Type.Literal("hello"), proof: Type.String(), ...dimensions }),
	Type.Object({ type: Type.Literal("resize"), ...dimensions }),
	Type.Object({ type: Type.Literal("input"), data: Type.String({ maxLength: 65536 }) }),
]);
export type PaneInput = Static<typeof PaneInputSchema>;

export const PaneOutputSchema = Type.Union([
	Type.Object({ type: Type.Literal("ready"), proof: Type.String() }),
	Type.Object({ type: Type.Literal("frame"), lines: Type.Array(Type.String(), { maxItems: 500 }) }),
	Type.Object({ type: Type.Literal("close") }),
]);
export type PaneOutput = Static<typeof PaneOutputSchema>;
