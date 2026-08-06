export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export interface SpanAttributes {
	[name: string]: AttributeValue | undefined;
}

export interface SpanOptions {
	name: string;
	attributes?: SpanAttributes;
}

export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

export interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}

export { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

export type TelemetryAttributeType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]";

export interface TelemetryAttributeMetadata {
	description: string;
	sensitive?: boolean;
	cardinality?: "low" | "high";
}

export type TelemetryAttributeDefinition = TelemetryAttributeMetadata &
	(
		| { type: "string"; values?: readonly string[]; examples?: readonly string[] }
		| { type: "number"; values?: readonly number[]; examples?: readonly number[] }
		| { type: "boolean"; values?: readonly boolean[]; examples?: readonly boolean[] }
		| { type: "string[]"; elementValues?: readonly string[]; examples?: readonly (readonly string[])[] }
		| { type: "number[]"; elementValues?: readonly number[]; examples?: readonly (readonly number[])[] }
		| { type: "boolean[]"; elementValues?: readonly boolean[]; examples?: readonly (readonly boolean[])[] }
	);

export type TelemetryStartAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };
export type TelemetryEventAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };

export interface TelemetryEventDefinition {
	description: string;
	attributes: Record<string, TelemetryEventAttributeDefinition>;
}

export type TelemetryParentDefinition =
	| { kind: "any" }
	| { kind: "root_or_external" }
	| { kind: "spans"; spans: readonly string[] };

export interface TelemetrySpanDefinition {
	description: string;
	parents: TelemetryParentDefinition;
	startAttributes: Record<string, TelemetryStartAttributeDefinition>;
	endAttributes: Record<string, TelemetryAttributeDefinition>;
	events?: Record<string, TelemetryEventDefinition>;
	status: { default: "ok"; errorWhen: string };
}

export interface TelemetrySchemaDefinition {
	version: number;
	spans: Record<string, TelemetrySpanDefinition>;
}

/** Typed identity helper for serializable telemetry schema data. */
export function defineTelemetrySchema<const T extends TelemetrySchemaDefinition>(schema: T): T {
	return schema;
}

type AttributeDefinitionValue<Definition extends TelemetryAttributeDefinition> = Definition extends {
	type: "string";
	values: readonly (infer Value extends string)[];
}
	? Value
	: Definition extends { type: "string" }
		? string
		: Definition extends { type: "number"; values: readonly (infer Value extends number)[] }
			? Value
			: Definition extends { type: "number" }
				? number
				: Definition extends { type: "boolean"; values: readonly (infer Value extends boolean)[] }
					? Value
					: Definition extends { type: "boolean" }
						? boolean
						: Definition extends {
									type: "string[]";
									elementValues: readonly (infer Value extends string)[];
								}
							? readonly Value[]
							: Definition extends { type: "string[]" }
								? readonly string[]
								: Definition extends {
											type: "number[]";
											elementValues: readonly (infer Value extends number)[];
										}
									? readonly Value[]
									: Definition extends { type: "number[]" }
										? readonly number[]
										: Definition extends {
													type: "boolean[]";
													elementValues: readonly (infer Value extends boolean)[];
												}
											? readonly Value[]
											: readonly boolean[];

type RequiredAttributeNames<
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = {
	[Name in keyof Definitions]-?: Definitions[Name]["required"] extends true ? Name : never;
}[keyof Definitions];

type OptionalAttributeNames<
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = Exclude<keyof Definitions, RequiredAttributeNames<Definitions>>;

export type InferRequiredAndOptionalAttributes<
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = keyof Definitions extends never
	? Record<string, never>
	: {
			[Name in RequiredAttributeNames<Definitions>]: AttributeDefinitionValue<Definitions[Name]>;
		} & {
			[Name in OptionalAttributeNames<Definitions>]?: AttributeDefinitionValue<Definitions[Name]>;
		};

export type InferStartAttributes<Definitions extends Record<string, TelemetryStartAttributeDefinition>> =
	InferRequiredAndOptionalAttributes<Definitions>;

export type InferOptionalAttributes<Definitions extends Record<string, TelemetryAttributeDefinition>> =
	keyof Definitions extends never
		? Record<string, never>
		: { [Name in keyof Definitions]?: AttributeDefinitionValue<Definitions[Name]> };

export type ExactTelemetryAttributes<Expected, Actual extends Expected> = Actual &
	Record<Exclude<keyof Actual, keyof Expected>, never>;

export type InferEventAttributes<Definitions extends Record<string, TelemetryEventAttributeDefinition>> =
	InferRequiredAndOptionalAttributes<Definitions>;

export type TelemetrySchemaSpanName<Schema extends TelemetrySchemaDefinition> = keyof Schema["spans"] & string;

type SchemaSpan<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = Schema["spans"][Name];

export type TelemetrySchemaSpanStartAttributes<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name>["startAttributes"] extends infer Definitions extends Record<
	string,
	TelemetryStartAttributeDefinition
>
	? InferStartAttributes<Definitions>
	: never;

export type TelemetrySchemaSpanEndAttributes<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name>["endAttributes"] extends infer Definitions extends Record<
	string,
	TelemetryAttributeDefinition
>
	? InferOptionalAttributes<Definitions>
	: never;

type SchemaSpanEvents<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name> extends { events: infer Events extends Record<string, TelemetryEventDefinition> }
	? Events
	: Record<never, never>;

export type TelemetrySchemaSpanEventName<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = keyof SchemaSpanEvents<Schema, Name> & string;

type SchemaSpanEvent<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvents<Schema, Name> extends infer Events
	? EventName extends keyof Events
		? Events[EventName]
		: never
	: never;

export type TelemetrySchemaSpanEventAttributes<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvent<Schema, Name, EventName> extends {
	attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
	? InferEventAttributes<Definitions>
	: never;

type SchemaSpanEventAttributeDefinitions<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvent<Schema, Name, EventName> extends {
	attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
	? Definitions
	: Record<never, never>;

type EventArguments<
	Definitions extends Record<string, TelemetryEventAttributeDefinition>,
	Attributes extends InferEventAttributes<Definitions>,
> = [RequiredAttributeNames<Definitions>] extends [never]
	? [attributes?: ExactTelemetryAttributes<InferEventAttributes<Definitions>, Attributes>]
	: [attributes: ExactTelemetryAttributes<InferEventAttributes<Definitions>, Attributes>];

export type SchemaTelemetrySpan<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = Omit<TelemetrySpan, "addEvent" | "setAttributes"> & {
	addEvent<
		EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
		const Attributes extends InferEventAttributes<
			SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>
		> = InferEventAttributes<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>>,
	>(
		name: EventName,
		...args: EventArguments<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>, Attributes>
	): void;
	setAttributes<const Attributes extends TelemetrySchemaSpanEndAttributes<Schema, Name>>(
		attributes: ExactTelemetryAttributes<TelemetrySchemaSpanEndAttributes<Schema, Name>, Attributes>,
	): void;
};

export type TelemetrySchemaSpanUnion<Schema extends TelemetrySchemaDefinition> = {
	[Name in TelemetrySchemaSpanName<Schema>]: {
		name: Name;
		startAttributes: TelemetrySchemaSpanStartAttributes<Schema, Name>;
		endAttributes: TelemetrySchemaSpanEndAttributes<Schema, Name>;
		events: {
			[EventName in TelemetrySchemaSpanEventName<Schema, Name>]: TelemetrySchemaSpanEventAttributes<
				Schema,
				Name,
				EventName
			>;
		};
	};
}[TelemetrySchemaSpanName<Schema>];

type TelemetrySchemaTuple = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];

type SpanNameInSchema<Schema extends TelemetrySchemaDefinition> = Schema extends TelemetrySchemaDefinition
	? TelemetrySchemaSpanName<Schema>
	: never;

type SpanNameInSchemas<Schemas extends TelemetrySchemaTuple> = SpanNameInSchema<Schemas[number]>;

type SpanStartAttributesInSchema<
	Schema extends TelemetrySchemaDefinition,
	Name extends string,
> = Schema extends TelemetrySchemaDefinition
	? Name extends TelemetrySchemaSpanName<Schema>
		? TelemetrySchemaSpanStartAttributes<Schema, Name>
		: never
	: never;

type SpanInSchema<
	Schema extends TelemetrySchemaDefinition,
	Name extends string,
> = Schema extends TelemetrySchemaDefinition
	? Name extends TelemetrySchemaSpanName<Schema>
		? SchemaTelemetrySpan<Schema, Name>
		: never
	: never;

type DuplicateTelemetrySpanNames<
	Schemas extends readonly TelemetrySchemaDefinition[],
	Seen extends string = never,
> = Schemas extends readonly [
	infer Schema extends TelemetrySchemaDefinition,
	...infer Rest extends readonly TelemetrySchemaDefinition[],
]
	?
			| Extract<TelemetrySchemaSpanName<Schema>, Seen>
			| DuplicateTelemetrySpanNames<Rest, Seen | TelemetrySchemaSpanName<Schema>>
	: never;

type UniqueTelemetrySchemas<Schemas extends TelemetrySchemaTuple> = [DuplicateTelemetrySpanNames<Schemas>] extends [
	never,
]
	? unknown
	: { readonly "duplicate telemetry span names": DuplicateTelemetrySpanNames<Schemas> };

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	value: infer Intersection,
) => void
	? Intersection
	: never;

type TypedSpanStarterForName<Schemas extends TelemetrySchemaTuple, Name extends SpanNameInSchemas<Schemas>> = <
	const Attributes extends SpanStartAttributesInSchema<Schemas[number], Name>,
	Result,
>(
	name: Name,
	attributes: ExactTelemetryAttributes<SpanStartAttributesInSchema<Schemas[number], Name>, Attributes>,
	callback: (
		span: SpanInSchema<Schemas[number], Name>,
		startChildSpan: TypedSpanStarter<Schemas>,
	) => Result | Promise<Result>,
) => Promise<Result>;

/** A per-span overload set bound to one explicit parent context and one or more schemas. */
export type TypedSpanStarter<Schemas extends TelemetrySchemaTuple> = UnionToIntersection<
	{
		[Name in SpanNameInSchemas<Schemas>]: TypedSpanStarterForName<Schemas, Name>;
	}[SpanNameInSchemas<Schemas>]
>;

function bindTypedSpanStarter<Schemas extends TelemetrySchemaTuple>(
	telemetryContext: TelemetryContext,
): TypedSpanStarter<Schemas> {
	const startSpan = (
		name: SpanNameInSchemas<Schemas>,
		attributes: SpanAttributes,
		callback: (
			span: SpanInSchema<Schemas[number], SpanNameInSchemas<Schemas>>,
			startChildSpan: TypedSpanStarter<Schemas>,
		) => unknown,
	): Promise<unknown> =>
		telemetryContext.startSpan({ name, attributes }, (span) =>
			callback(
				span as SpanInSchema<Schemas[number], SpanNameInSchemas<Schemas>>,
				bindTypedSpanStarter<Schemas>(span),
			),
		);

	return startSpan as TypedSpanStarter<Schemas>;
}

/**
 * Bind an explicit parent context to the combined span vocabulary of one or more schemas.
 * Schema values are used only for type inference; no runtime schema validation is performed.
 */
export function createTypedSpanStarter<const Schemas extends TelemetrySchemaTuple>(
	telemetryContext: TelemetryContext,
	_schemas: Schemas & UniqueTelemetrySchemas<Schemas>,
): TypedSpanStarter<Schemas> {
	return bindTypedSpanStarter<Schemas>(telemetryContext);
}

export type { RecordedTelemetryEvent, RecordedTelemetrySpan } from "./memory.ts";
export { InMemoryTelemetryContext } from "./memory.ts";
