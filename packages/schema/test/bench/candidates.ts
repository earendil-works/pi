// The validators the benchmarks compare, each behind the same interface: compile a schema, then check values.
// Every library is used through its fastest boolean path and keeps the object it returns, as an application would.
// Run the benchmarks through `npm run bench`, which sets ATA_NO_NATIVE=1: ata-validator's optional native addon only
// serves its buffer APIs, and the verdicts measured here are JavaScript either way.

import { Validator as CfValidator } from "@cfworker/json-schema";
import { fromJsonSchema } from "@oh-my-pi/omptype";
import Ajv7Module from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import draft07MetaSchema from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import addFormatsModule from "ajv-formats";
import { Validator as AtaValidator } from "ata-validator";
import { Compile } from "typebox/compile";
import { ResetExternal, ResetFunctions } from "typebox/schema";
import { Settings } from "typebox/system";
import { compile, type FormatCheck, type JsonSchema } from "../../src/index.ts";
import { nativeCases, nativeZod, zodFromJsonSchema } from "./zod.ts";

/** How a benchmark compiles a schema. */
export interface PrepareOptions {
	readonly draft: "2020-12" | "7";
	readonly schemas?: Readonly<Record<string, JsonSchema>>;
	readonly formats?: Readonly<Record<string, FormatCheck>>;
	/** The schema is a JSON-Schema-Test-Suite schema (for libraries that take native schemas otherwise). */
	readonly suite?: boolean;
}

/** A compiled schema: its boolean check and the object the library returned (kept alive by the caller). */
export interface Prepared {
	readonly check: (value: unknown) => boolean;
	readonly validator: unknown;
}

/** A library under comparison. */
export interface Candidate {
	readonly name: string;
	readonly prepare: (schema: JsonSchema, options: PrepareOptions) => Prepared;
}

/** Whether this process runs with code generation from strings disabled, as under a strict CSP. */
export const noEval = process.execArgv.includes("--disallow-code-generation-from-strings");

const piSchema: Candidate = {
	name: "pi-schema",
	prepare(schema, options) {
		const validator = compile(schema, options);
		return { check: validator.check, validator };
	},
};

// TypeBox keeps its last build in module-level accumulators; reset them so no build state is retained between schemas.
function typeboxCompile(schema: JsonSchema, options: PrepareOptions, accelerate: boolean) {
	Settings.Set({ useAcceleration: accelerate });
	try {
		return Compile((options.schemas ?? {}) as never, schema as never);
	} finally {
		ResetFunctions();
		ResetExternal();
		Settings.Set({ useAcceleration: true });
	}
}

const typebox: Candidate = {
	name: noEval ? "typebox (no eval: interpreter)" : "typebox",
	prepare(schema, options) {
		const validator = typeboxCompile(schema, options, true);
		return { check: (v) => validator.Check(v), validator };
	},
};

const typeboxInterpreter: Candidate = {
	name: "typebox interpreter",
	prepare(schema, options) {
		const validator = typeboxCompile(schema, options, false);
		return { check: (v) => validator.Check(v), validator };
	},
};

const cfworker: Candidate = {
	name: "cfworker",
	prepare(schema, options) {
		const validator = new CfValidator(schema as never, options.draft, true);
		for (const [uri, remote] of Object.entries(options.schemas ?? {})) validator.addSchema(remote as never, uri);
		return { check: (v) => validator.validate(v).valid, validator };
	},
};

// omptype compiles with new Function on the first allows() call. Without eval that call throws EvalError once per
// schema; omptype then keeps validating through its interpreter, so the benchmark absorbs that one throw.
const omptype: Candidate = {
	name: noEval ? "omptype (no eval: interpreter)" : "omptype",
	prepare(schema) {
		const validator = fromJsonSchema(schema);
		if (noEval) {
			try {
				validator.allows(null);
			} catch (error) {
				if (!(error instanceof EvalError)) throw error;
			}
		}
		return { check: (v) => validator.allows(v), validator };
	},
};

// Ajv's CommonJS modules export the class as module.exports and as `default`; the latter is what its types describe.
const Ajv2020 = Ajv2020Module.default;
const Ajv7 = Ajv7Module.default;
const addFormats = addFormatsModule.default;
type AjvInstance = InstanceType<typeof Ajv2020>;

// One Ajv per draft, as an application keeps it. Ajv2020 also gets the draft-07 meta-schema, so tool schemas that
// declare draft-07 compile. strict: false so schemas written for other tools compile; logger: false keeps Ajv from
// printing generated code when compiling fails without eval.
function newAjv(draft: "2020-12" | "7", formats: boolean): AjvInstance {
	const options = { strict: false, validateFormats: formats, logger: false as const };
	const ajv = draft === "7" ? new Ajv7(options) : new Ajv2020(options);
	if (draft !== "7") ajv.addMetaSchema(draft07MetaSchema);
	if (formats) addFormats(ajv);
	return ajv;
}

const sharedAjv = new Map<string, AjvInstance>();

// Ajv compiles with new Function and has no interpreter: without eval, compile() throws EvalError.
const ajv: Candidate = {
	name: noEval ? "ajv (no eval: fails)" : "ajv",
	prepare(schema, options) {
		let instance: AjvInstance;
		if (options.schemas === undefined) {
			const key = `${options.draft} ${options.formats !== undefined}`;
			instance = sharedAjv.get(key) ?? newAjv(options.draft, options.formats !== undefined);
			sharedAjv.set(key, instance);
		} else {
			// The suite reuses $ids across groups, which one shared instance would reject: a fresh one per schema.
			instance = newAjv(options.draft, options.formats !== undefined);
			for (const [uri, remote] of Object.entries(options.schemas)) {
				// Ajv ships its own meta-schemas; adding them again under the same id throws.
				if (instance.getSchema(uri) === undefined) {
					try {
						instance.addSchema(remote as object, uri);
					} catch {
						// A remote whose $id Ajv already registered under another key.
					}
				}
			}
		}
		const validator = instance.compile(schema as object);
		return { check: (v) => validator(v) as boolean, validator };
	},
};

// ata-validator: its defaults fill `default` values into the input and assert `format`; both are turned off to match
// the other candidates (format checks only in the format run, with its own checks). It reads the draft only from
// $schema, so a draft 7 schema without one gets it declared.
function ataValidator(schema: JsonSchema, options: PrepareOptions, engine: "interpreter" | undefined) {
	const declared =
		options.draft === "7" && typeof schema === "object" && !("$schema" in schema)
			? { $schema: "http://json-schema.org/draft-07/schema#", ...schema }
			: schema;
	return new AtaValidator(declared, {
		useDefaults: false,
		assertFormat: options.formats !== undefined,
		schemas: (options.schemas ?? {}) as Record<string, object>,
		logger: false,
		...(engine === undefined ? {} : { engine }),
	});
}

// Generated code, or its interpreted engine where code generation is blocked.
const ata: Candidate = {
	name: noEval ? "ata (no eval: interpreter)" : "ata",
	prepare(schema, options) {
		const validator = ataValidator(schema, options, undefined);
		return { check: (v) => validator.isValidObject(v), validator };
	},
};

// Its eval-free engine, a tree of closures, chosen explicitly: what it runs on for schemas from outside.
const ataInterpreter: Candidate = {
	name: "ata interpreter",
	prepare(schema, options) {
		const validator = ataValidator(schema, options, "interpreter");
		return { check: (v) => validator.isValidObject(v), validator };
	},
};

// Zod: native Zod schemas for the speed cases and the corpus, z.fromJSONSchema only for the suite. Its object parser
// generates code with new Function when it can and parses without it otherwise; safeParse is its boolean path.
const zod: Candidate = {
	name: noEval ? "zod (no eval: no JIT)" : "zod",
	prepare(schema, options) {
		const validator = options.suite
			? zodFromJsonSchema(schema, options.draft)
			: (nativeCases.get(schema) ?? nativeZod(schema as Record<string, unknown>));
		return { check: (v) => validator.safeParse(v).success, validator };
	},
};

/** Every candidate, ours first. */
export const candidates: readonly Candidate[] = [piSchema, typebox, ajv, ata, ataInterpreter, zod, cfworker, omptype];

/** Candidates by name, including TypeBox's interpreter (what TypeBox runs when eval is unavailable). */
export const byName: ReadonlyMap<string, Candidate> = new Map(
	[...candidates, typeboxInterpreter].map((c) => [c.name.split(" (")[0], c]),
);
