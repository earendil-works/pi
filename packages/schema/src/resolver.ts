// Reference resolution of one compile: schema resources, anchors and JSON Pointers over the root schema and the
// registered documents. A Resolver lives only while a schema compiles (or while its errors are explained).

import type { CompileOptions, JsonSchema, SchemaObject } from "./types.ts";

/** A schema and the base URI its references resolve against. */
export interface Resolved {
	readonly node: unknown;
	readonly base: string;
}

/** The base URI of a root schema without `$id`; relative references resolve against it. */
export const DEFAULT_BASE = "https://json-schema.invalid/root.json";

/**
 * Resolves references in the root schema and the registered documents. The schema is indexed on the first
 * reference, so a schema without references is never walked for identifiers.
 */
export class Resolver {
	readonly draft: "2020-12" | "7";
	readonly rootBase: string;
	/** Schema object to the base URI it was indexed under. */
	readonly baseOf = new Map<object, string>();
	/** URI (with a `#name` fragment) of every `$dynamicAnchor`, to its schema. */
	readonly dynamicAnchors = new Map<string, SchemaObject>();
	private readonly root: JsonSchema;
	private readonly options: CompileOptions;
	private readonly registry = new Map<string, JsonSchema>();
	private readonly rejectUnresolved: boolean;
	/** The references that named nothing and resolved to `false` (with `unresolvedRefs: "reject"`). */
	private readonly unresolved = new Set<string>();
	private readonly resources = new Map<string, unknown>();
	private readonly anchors = new Map<string, SchemaObject>();
	private indexed = false;

	constructor(root: JsonSchema, options: CompileOptions) {
		this.draft = options.draft === "7" ? "7" : "2020-12";
		this.root = root;
		this.options = options;
		this.rejectUnresolved = options.unresolvedRefs === "reject";
		this.rootBase = isSchemaObject(root) ? this.baseFor(root, DEFAULT_BASE) : DEFAULT_BASE;
	}

	/**
	 * The base URI of `node`, whose parent has `base`: its `$id` changes it, unless draft 7 makes the `$id` inert. Once
	 * the schema is indexed, the indexed base (a resolved reference target already has its own).
	 */
	baseFor(node: SchemaObject, base: string): string {
		const indexed = this.baseOf.get(node);
		if (indexed !== undefined) return indexed;
		const id = node.$id;
		if (typeof id !== "string") return base;
		if (this.draft === "7" && (typeof node.$ref === "string" || id.startsWith("#"))) return base;
		return documentOf(resolveUri(id, base));
	}

	/** Indexes the root schema and the registered documents' URIs (once). */
	ensureIndexed(): void {
		if (this.indexed) return;
		this.indexed = true;
		for (const [uri, schema] of Object.entries(this.options.schemas ?? {})) {
			this.registry.set(documentOf(resolveUri(uri, DEFAULT_BASE)), schema);
		}
		this.resources.set(DEFAULT_BASE, this.root);
		this.index(this.root, DEFAULT_BASE);
	}

	/**
	 * The schema a reference names, with the base URI it compiles under. Throws if it names nothing, or, with
	 * `unresolvedRefs: "reject"`, resolves to `false`, the schema no value passes.
	 */
	resolve(ref: string, base: string): Resolved {
		this.ensureIndexed();
		if (!this.rejectUnresolved) return this.find(ref, base);
		try {
			return this.find(ref, base);
		} catch {
			this.unresolved.add(resolveUri(ref, base));
			return { node: false, base };
		}
	}

	/** Whether `ref`, from `base`, named nothing and resolved to `false`. */
	isUnresolved(ref: string, base: string): boolean {
		return this.unresolved.has(resolveUri(ref, base));
	}

	private find(ref: string, base: string): Resolved {
		const uri = resolveUri(ref, base);
		const doc = documentOf(uri);
		const fragment = uri.length > doc.length ? decodeURIComponent(uri.slice(doc.length + 1)) : "";
		const root = this.resources.has(doc) ? this.resources.get(doc) : this.load(doc);
		if (root === undefined) throw new Error(`Unresolved $ref ${ref} (no schema registered for ${doc})`);
		if (fragment === "") return { node: root, base: doc };
		if (fragment.startsWith("/")) return this.pointer(root, doc, fragment);
		const target = this.anchors.get(`${doc}#${fragment}`);
		if (target === undefined) throw new Error(`Unresolved $ref ${ref} (no anchor ${fragment} in ${doc})`);
		return { node: target, base: this.baseOf.get(target) ?? doc };
	}

	/** Whether `node` is the root of the schema resource at `base`. */
	isResource(node: object, base: string): boolean {
		this.ensureIndexed();
		return this.resources.get(base) === node;
	}

	// Walks only keywords that hold subschemas: an `$id` inside `enum`, `const` or an unknown keyword names nothing.
	private index(node: unknown, base: string): void {
		if (!isSchemaObject(node) || this.baseOf.has(node)) return;
		let b = base;
		// In draft 7 a `$ref` makes every sibling keyword, `$id` included, inert.
		const refOnly = this.draft === "7" && typeof node.$ref === "string";
		if (!refOnly && typeof node.$id === "string") {
			if (this.draft === "7" && node.$id.startsWith("#")) this.anchors.set(documentOf(b) + node.$id, node);
			else {
				const uri = resolveUri(node.$id, b);
				b = documentOf(uri);
				this.resources.set(b, node);
				if (uri.length > b.length + 1) this.anchors.set(uri, node);
			}
		}
		this.baseOf.set(node, b);
		if (refOnly) return;
		if (this.draft !== "7") {
			if (typeof node.$anchor === "string") this.anchors.set(`${b}#${node.$anchor}`, node);
			if (typeof node.$dynamicAnchor === "string") {
				this.anchors.set(`${b}#${node.$dynamicAnchor}`, node);
				this.dynamicAnchors.set(`${b}#${node.$dynamicAnchor}`, node);
			}
		}
		for (const key of SCHEMA_KEYWORDS) this.index(node[key], b);
		for (const key of MAP_KEYWORDS) {
			const map = node[key];
			if (isSchemaObject(map)) for (const k of Object.keys(map)) this.index(map[k], b);
		}
		for (const key of ARRAY_KEYWORDS) {
			const list = node[key];
			if (Array.isArray(list)) for (const s of list) this.index(s, b);
		}
	}

	private load(doc: string): JsonSchema | undefined {
		const schema = this.registry.get(doc);
		if (schema === undefined) return undefined;
		this.resources.set(doc, schema);
		this.index(schema, doc);
		return schema;
	}

	private pointer(root: unknown, base: string, fragment: string): Resolved {
		let node = root;
		let b = base;
		for (const raw of fragment.split("/").slice(1)) {
			const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
			node =
				typeof node === "object" && node !== null && Object.hasOwn(node, key)
					? (node as SchemaObject)[key]
					: undefined;
			if (node === undefined) throw new Error(`Unresolved $ref #${fragment} in ${base}`);
			if (typeof node === "object" && node !== null) b = this.baseOf.get(node) ?? b;
		}
		return { node, base: b };
	}
}

const SCHEMA_KEYWORDS = [
	"additionalProperties",
	"propertyNames",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"unevaluatedProperties",
	"unevaluatedItems",
	"additionalItems",
	"contentSchema",
	"items",
];

const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];

const ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];

/** Whether `value` is a schema object (not `true`/`false`, an array or a primitive). */
export function isSchemaObject(value: unknown): value is SchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `ref` resolved against `base`. URNs and other bases a URL parser rejects take fragment-only references. */
export function resolveUri(ref: string, base: string): string {
	try {
		return new URL(ref, base).href;
	} catch {
		return ref.startsWith("#") ? documentOf(base) + ref : ref;
	}
}

/** `uri` without its fragment. */
export function documentOf(uri: string): string {
	const hash = uri.indexOf("#");
	return hash < 0 ? uri : uri.slice(0, hash);
}
