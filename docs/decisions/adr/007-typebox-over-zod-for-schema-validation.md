# 007: TypeBox Over Zod for Schema Validation

**Date:** 2025-09-16
**Source:** Commit `e8370436`

## Context

The agent needed tool parameter validation: JSON Schema-based, works at runtime, integrates with provider APIs. Zod was chosen initially but had a problem: its schemas aren't serializable to plain JSON. Tool definitions that include Zod schemas can't be sent to provider APIs that expect JSON Schema. The AI provider abstraction (ADR-003) sends tool definitions to Anthropic, OpenAI, and Google, all of which accept JSON Schema `parameters`. Zod's `.describe()` output is close but not always compatible, and there's no clean way to extract a plain JSON Schema from a Zod type.

## Decision

Replace Zod with TypeBox for tool parameter schema definitions. TypeBox schemas compile to plain JSON Schema objects that serialize and deserialize without loss. Runtime validation uses AJV instead of Zod's `.parse()`. A `StringEnum` helper bridges the gap for Google's API, which rejects `anyOf`/`const` patterns that TypeBox generates for enums.

## Consequences

- Tool schemas serialize to JSON naturally. Provider APIs get the JSON Schema they expect.
- AJV replaces Zod for validation. Comparable API but different error messages and edge-case behavior.
- TypeBox's type inference (`Static<typeof T>`) mirrors Zod's `z.infer`. Migration is straightforward.
- The switch happened days after Zod was introduced, which means tool code never accumulated a deep Zod dependency
- A `StringEnum` workaround was needed for Google compatibility. The provider's JSON Schema parser has quirks.

## Confidence

High. commit body documents the motivation in detail.
