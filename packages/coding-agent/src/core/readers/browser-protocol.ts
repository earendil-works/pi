// Private loopback protocol for leasing the Pi-owned project browser and individual tabs.
import { type Static, Type } from "typebox";

export const ProjectBrowserMetadataSchema = Type.Object(
	{ port: Type.Integer({ minimum: 1, maximum: 65535 }), token: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
	{ additionalProperties: false },
);
export type ProjectBrowserMetadata = Static<typeof ProjectBrowserMetadataSchema>;

export const ProjectBrowserInitSchema = Type.Object(
	{ profileDir: Type.String(), settingsKey: Type.String(), executablePath: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
export type ProjectBrowserInit = Static<typeof ProjectBrowserInitSchema>;

export const ProjectBrowserRequestSchema = Type.Object(
	{
		token: Type.String(),
		settingsKey: Type.String(),
		action: Type.Union([Type.Literal("lease"), Type.Literal("page")]),
	},
	{ additionalProperties: false },
);

export const ProjectBrowserConnectionSchema = Type.Object(
	{ endpoint: Type.String(), pageUrl: Type.String() },
	{ additionalProperties: false },
);
export type ProjectBrowserConnection = Static<typeof ProjectBrowserConnectionSchema>;

export const ProjectBrowserResponseSchema = Type.Union([
	Type.Object(
		{ ok: Type.Literal(true), endpoint: Type.String(), pageUrl: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object({ ok: Type.Literal(false), error: Type.String() }, { additionalProperties: false }),
]);
export type ProjectBrowserResponse = Static<typeof ProjectBrowserResponseSchema>;
export const MAX_BROWSER_MESSAGE_BYTES = 8192;
