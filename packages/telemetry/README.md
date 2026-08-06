# @earendil-works/pi-telemetry

Vendor-neutral telemetry contracts and typed schema utilities for pi packages.

This package provides:

- an explicit, callback-based `TelemetryContext` / `TelemetrySpan` contract;
- a shared `NOOP_TELEMETRY_CONTEXT`;
- a reference `InMemoryTelemetryContext` implementation;
- serializable schema definitions with inferred TypeScript types;
- no exporter, global current-span state, or dependency on a telemetry backend.

Applications can use the in-memory reference or provide an adapter for OpenTelemetry, Sentry, logs, or another backend. Pi packages pass telemetry contexts explicitly and define their domain schemas separately.

## Table of Contents

- [Installation](#installation)
- [Telemetry Concepts](#telemetry-concepts)
- [Core Context API](#core-context-api)
- [Adapter Contract](#adapter-contract)
- [No-op Context](#no-op-context)
- [In-Memory Reference Adapter](#in-memory-reference-adapter)
- [Adapter Conformance](#adapter-conformance)
- [Typed Schemas](#typed-schemas)
  - [Start and Completion Attributes](#start-and-completion-attributes)
- [Schema Metadata](#schema-metadata)
- [Pi Package Integration](#pi-package-integration)
- [Security and Portability](#security-and-portability)
- [API Reference](#api-reference)
- [Development](#development)
- [License](#license)

## Installation

```bash
npm install @earendil-works/pi-telemetry
```

## Telemetry Concepts

Telemetry describes what a program did while it was running. This package models that work using spans, attributes, events, statuses, and explicit context:

| Concept | Plain-language meaning |
|---|---|
| **Span** | A timed record of one operation, such as loading an account or making an AI request. It begins before the work and ends when the work finishes. |
| **Parent and child spans** | Operations can contain smaller operations. A request span might contain a cache lookup and a database query. Together they form a tree showing where time was spent. |
| **Attribute** | A named fact attached to a span, such as `provider: "openai"`, `cache.hit: true`, or `item_count: 12`. Attributes describe the operation and its result. |
| **Event** | A named occurrence at a point during a span, such as `retry.scheduled` or `cache.lookup`. Events have no duration and may carry their own attributes. |
| **Status** | The operation's outcome: `ok` or `error`. An error status may include an error name and message. |
| **Context** | A handle identifying where new work belongs in the span tree. Starting a span from a context makes it a child of that context. |

For example, loading an account could produce this telemetry:

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   facts about the span
├─ event: example.cache.lookup              occurrence during the span
│  └─ attribute: cache.hit=false            fact about the event
└─ status: ok                               final outcome
```

A span is diagnostic data, not business state. Recording it must not change whether the account load runs, succeeds, fails, or is persisted. An adapter translates these generic concepts into the corresponding concepts used by OpenTelemetry, Sentry, logs, or another backend.

## Core Context API

A `TelemetryContext` starts a span around a callback. The callback receives a `TelemetrySpan`, which is also the explicit parent context for child spans.

```typescript
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
} from '@earendil-works/pi-telemetry';

async function loadAccount(
  accountId: string,
  telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
) {
  return telemetryContext.startSpan(
    {
      name: 'example.account.load',
      attributes: { 'example.account.id': accountId },
    },
    async (span) => {
      const account = await readAccount(accountId);
      span.setAttributes({ 'example.account.found': account !== undefined });
      return account;
    },
  );
}
```

Pass the callback span to lower-level work to create explicit nesting:

```typescript
return telemetryContext.startSpan({ name: 'example.parent' }, async (parentSpan) => {
  return parentSpan.startSpan({ name: 'example.child' }, async (childSpan) => {
    childSpan.addEvent('example.cache.lookup', { 'example.cache.hit': true });
    return performWork();
  });
});
```

There is no public `end()` method. `startSpan()` owns settlement and keeps the span open until the callback's value or promise settles. For an expected failure represented by a normal return value, set the status explicitly:

```typescript
return telemetryContext.startSpan({ name: 'example.save' }, async (span) => {
  const result = await save();
  if (!result.ok) {
    span.setStatus({
      status: 'error',
      error: { name: 'SaveError', message: result.reason },
    });
  }
  return result;
});
```

## Adapter Contract

An adapter implements `TelemetryContext` and bridges the generic API to its backend. It must:

- create a child span and invoke the callback synchronously, exactly once;
- preserve the callback's returned value and rejection value, returning a promise rejected with the same value after a synchronous throw;
- keep the native span open until a returned promise settles;
- treat normal completion as `ok` and throws/rejections as errors unless an explicit status was set;
- make repeated `setStatus()` calls last-write-wins;
- merge `setAttributes()` calls, with later defined values replacing earlier values and `undefined` ignored;
- make recording methods synchronous, passive, and non-throwing;
- ignore calls made after settlement;
- ignore a failed recording call atomically, suppress backend failures, and still execute the business callback exactly once.

Adapters may activate backend-native ambient context internally for automatic instrumentation, but pi code always propagates the parent through `TelemetryContext` arguments. Exporter buffering, flushing, sampling, backend IDs, and backend-specific context objects belong to the adapter. Use the [adapter conformance suite](#adapter-conformance) to check these observable semantics.

## No-op Context

Use `NOOP_TELEMETRY_CONTEXT` when telemetry is optional:

```typescript
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry';

const result = await NOOP_TELEMETRY_CONTEXT.startSpan(
  { name: 'example.operation' },
  () => runOperation(),
);
```

The no-op context:

- invokes callbacks synchronously;
- preserves returned values and asynchronous rejections, and converts a synchronous throw to a promise rejected with the same value;
- uses one shared frozen inert span, including for nested spans;
- does not inspect or retain names, attributes, events, or statuses.

## In-Memory Reference Adapter

`InMemoryTelemetryContext` is the backend-neutral reference implementation. It is useful for tests, local diagnostics, and applications that intentionally want process-local capture without an exporter:

```typescript
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();

await telemetry.startSpan(
  { name: 'example.operation', attributes: { input: 'demo' } },
  async (span) => {
    span.addEvent('example.started');
    span.setAttributes({ output_count: 3 });
  },
);

console.log(telemetry.getSpans());
```

`getSpans()` returns detached snapshots in span-start order. Each `RecordedTelemetrySpan` contains a deterministic numeric ID, parent ID, merged attributes, ordered events, final status, settlement state, and deterministic end sequence. It records no timestamps.

The adapter is safe to use as an ordinary `TelemetryContext`, but storage is unbounded and process-local. Create a fresh instance to isolate tests or recording scopes, and do not capture sensitive attributes unless the caller's data policy allows them.

## Adapter Conformance

`@earendil-works/pi-telemetry/testing` exports a runner-independent conformance suite modeled as grouped cases. A fixture supplies a fresh context and converts its backend's finished spans into normalized `RecordedTelemetrySpan` snapshots:

```typescript
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from '@earendil-works/pi-telemetry/testing';
import { describe, it } from 'vitest';

const conformance = createTelemetryAdapterConformance(async () => {
  const adapter = createMyTelemetryAdapter();
  return {
    context: adapter.context,
    getSpans: async () => adapter.normalizedSpans(),
    async [Symbol.asyncDispose]() {
      await adapter.close();
    },
  } satisfies TelemetryAdapterFixture;
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(group, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
      it(testCase.name, () => testCase.run());
    }
  });
}
```

The suite checks synchronous single admission, result and rejection identity, automatic and explicit status, attribute merging, event ordering, inert post-settlement calls, nested and concurrent parentage, and suppression of unreadable telemetry payload failures. `getSpans()` may flush an asynchronous exporter before returning. The testing subpath uses Node's assertion APIs; the root telemetry package remains runtime-neutral.

## Typed Schemas

The low-level span API intentionally accepts open names and attribute bags so adapters remain generic. Domain packages can define closed, serializable schemas and infer exact TypeScript types from them.

```typescript
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
} from '@earendil-works/pi-telemetry';

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    'example.read': {
      description: 'Read one resource',
      parents: { kind: 'any' },
      startAttributes: {
        'example.resource': {
          type: 'string',
          required: true,
          values: ['account', 'project'],
          description: 'Resource kind',
        },
      },
      endAttributes: {
        'example.item_count': {
          type: 'number',
          description: 'Number of returned items',
        },
      },
      events: {
        'example.cache': {
          description: 'Cache lookup result',
          attributes: {
            'example.cache.hit': {
              type: 'boolean',
              required: true,
              description: 'Whether the cache contained the resource',
            },
          },
        },
      },
      status: {
        default: 'ok',
        errorWhen: 'The read throws or returns an error result',
      },
    },
  },
} as const);

const startSpan = createTypedSpanStarter(
  telemetryContext,
  [EXAMPLE_TELEMETRY_SCHEMA],
);
```

The starter exposes one overload per span and checks names and attributes at compile time. Union-valued names must be narrowed before a call, preserving the relationship between each runtime name and its attribute schema. Its callback receives a child starter over the same schemas, already bound to the callback span:

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' },
  async (span, startChildSpan) => {
    span.addEvent('example.cache', { 'example.cache.hit': true });
    const accounts = await readAccounts();
    span.setAttributes({ 'example.item_count': accounts.length });

    await startChildSpan(
      'example.read',
      { 'example.resource': 'project' },
      async (childSpan) => {
        const projects = await readProjects();
        childSpan.setAttributes({ 'example.item_count': projects.length });
      },
    );

    return accounts;
  },
);
```

### Start and Completion Attributes

`startAttributes` and `endAttributes` describe when an attribute is normally known, not separate runtime storage:

| Schema field | How values are recorded | Requiredness |
|---|---|---|
| `startAttributes` | Passed in the typed starter's `attributes` argument when the span is created | Each definition explicitly sets `required: true` or `false` |
| `endAttributes` | Added later through the schema-scoped span's `setAttributes()` method | Always optional |

Both sets become ordinary attributes on the same backend span. There is no separate end-attribute payload or end callback. In the preceding example, `example.resource` is known when `example.read` starts, while `example.item_count` is known only after `readAccounts()` returns:

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' }, // required start attribute
  async (span) => {
    const accounts = await readAccounts();
    span.setAttributes({
      'example.item_count': accounts.length, // optional completion attribute
    });
    return accounts;
  },
); // resolving the callback settles the span
```

“End” means completion enrichment: an end attribute may be set at any point while the callback is active, and it may be omitted when unavailable. Calling `setAttributes()` zero times is valid. This matters for early failures, cancellation, and provider-specific data that may not exist on every path.

Repeated `setAttributes()` calls merge into the same attribute bag. A later defined value replaces an earlier value for the same key, while `undefined` is ignored. The schema-scoped method accepts only the current span's declared end attributes.

Attributes do not end the span. Returning, resolving, throwing, or rejecting from the callback controls settlement; `startSpan()` performs the actual end operation. Adapter calls made after settlement are inert.

A starter can compose multiple independently versioned schemas:

```typescript
import { AGENT_TELEMETRY_SCHEMAS } from '@earendil-works/pi-agent-core';

const startAgentSpan = createTypedSpanStarter(
  telemetryContext,
  AGENT_TELEMETRY_SCHEMAS,
);
```

Inline schema arrays retain their tuple types automatically. Separately declared arrays should use `as const`. Literal duplicate span names across the array are rejected at compile time; schemas are not merged, inspected, or retained at runtime.

Schema-derived types reject missing required attributes, unknown keys, invalid closed-set values, undeclared events, and attributes on empty schemas. End attributes are always optional enrichment; the type system does not require `setAttributes()` to be called.

`defineTelemetrySchema()` is a typed identity function. It returns ordinary JSON-serializable data and performs no runtime validation or parent-rule enforcement.

## Schema Metadata

Supported attribute types are:

- `string`, `number`, and `boolean`;
- `string[]`, `number[]`, and `boolean[]`.

Attribute definitions support:

- `values`: a closed set for scalar values;
- `elementValues`: a closed set for array elements;
- `examples`: documentation examples;
- `sensitive`: marks data requiring special handling;
- `cardinality`: records expected `low` or `high` cardinality.

Start and event attributes declare `required`. End attributes do not; see [Start and Completion Attributes](#start-and-completion-attributes).

Parent metadata is descriptive schema data:

- `{ kind: 'any' }`: root or any caller span;
- `{ kind: 'root_or_external' }`: root or a caller-owned span outside the schema;
- `{ kind: 'spans', spans: [...] }`: only the listed schema spans.

Adapters do not need to understand schema objects. Instrumentation helpers and tests use them to keep emitted names and attributes consistent.

## Pi Package Integration

Package ownership is intentionally split:

- `@earendil-works/pi-telemetry` owns the vendor-neutral contract, no-op and in-memory reference contexts, schema utilities, and adapter conformance suite;
- `@earendil-works/pi-ai` accepts and propagates `telemetryContext` in provider request options but owns no telemetry schema;
- `@earendil-works/pi-agent-core` owns and exports the pi AI-request and harness schemas, their combined readonly schema tuple, and typed span helpers.

```typescript
import {
  AGENT_TELEMETRY_SCHEMAS,
  AI_TELEMETRY_SCHEMA,
  HARNESS_TELEMETRY_SCHEMA,
  startAiSpan,
  startHarnessSpan,
} from '@earendil-works/pi-agent-core';
```

The pi schemas use pi-owned `pi.ai.*`, `pi.harness.*`, and `pi.session.*` names. Adapters may translate them to backend conventions without changing the emitted pi vocabulary.

## Security and Portability

Telemetry is process-local diagnostics, not durable application state. Do not persist a `TelemetryContext`, `TelemetrySpan`, or backend-native trace object in records, messages, snapshots, or deferred handles.

Attribute values are intentionally limited to primitive scalars and arrays. Domain instrumentation should avoid prompts, completions, tool arguments or output, file contents, provider payloads, headers, credentials, and free-form error details unless its schema and data policy explicitly allow them.

The package does not use `AsyncLocalStorage` or another runtime-specific ambient context API. It is suitable for Node.js, Bun, browsers, and workers; backend adapters remain responsible for their own runtime compatibility.

## API Reference

### Core types and values

| Export | Purpose |
|---|---|
| `TelemetryContext` | Starts callback-managed child spans |
| `TelemetrySpan` | Records attributes, events, and status; also acts as a child context |
| `SpanOptions` | Span name and optional start attributes |
| `SpanAttributes` / `AttributeValue` | Open adapter-level attribute bag and supported values |
| `SpanStatus` | Explicit `ok` or `error` status |
| `NOOP_TELEMETRY_CONTEXT` | Shared passive context for disabled telemetry |
| `InMemoryTelemetryContext` | Reference adapter with deterministic process-local recording |
| `RecordedTelemetrySpan` | Normalized captured span snapshot |
| `RecordedTelemetryEvent` | Normalized captured event snapshot |

### Schema definitions and inference

| Export | Purpose |
|---|---|
| `defineTelemetrySchema()` | Typed identity helper for serializable schema data |
| `createTypedSpanStarter()` | Binds a parent context to one or more schema vocabularies |
| `TypedSpanStarter` | Exact starter type with recursively child-bound callbacks |
| `TelemetrySchemaDefinition` | Top-level schema shape |
| `TelemetrySpanDefinition` | Span metadata, parents, attributes, events, and status rule |
| `TelemetryAttributeType` | Supported scalar and array type names |
| `TelemetryAttributeMetadata` | Description, sensitivity, and cardinality metadata |
| `TelemetryAttributeDefinition` | Attribute type, allowed values, examples, and metadata |
| `TelemetryStartAttributeDefinition` | Start attribute definition with requiredness |
| `TelemetryEventAttributeDefinition` | Event attribute definition with requiredness |
| `TelemetryEventDefinition` | Event description and attribute definitions |
| `TelemetryParentDefinition` | Open, external-root, or finite schema-parent rule |
| `TelemetrySchemaSpanName` | Union of declared span names |
| `TelemetrySchemaSpanStartAttributes` | Exact inferred start attributes for one span |
| `TelemetrySchemaSpanEndAttributes` | Optional inferred end attributes for one span |
| `TelemetrySchemaSpanEventName` | Union of events declared by one span |
| `TelemetrySchemaSpanEventAttributes` | Exact inferred attributes for one event |
| `SchemaTelemetrySpan` | Span view restricted to one schema span |
| `TelemetrySchemaSpanUnion` | Discriminated union of all spans in a schema |
| `InferStartAttributes` | Required and optional values inferred from start definitions |
| `InferOptionalAttributes` | Optional values inferred from end definitions |
| `InferEventAttributes` | Required and optional values inferred from event definitions |
| `InferRequiredAndOptionalAttributes` | Shared inference utility for definitions with requiredness |
| `ExactTelemetryAttributes` | Rejects keys outside an expected attribute set |

### Testing subpath

| Export | Purpose |
|---|---|
| `createTelemetryAdapterConformance()` | Creates runner-independent adapter conformance cases |
| `TelemetryAdapterFixture` | Fresh context and normalized snapshot reader for one case |
| `TelemetryAdapterFixtureFactory` | Creates isolated fixtures |
| `TelemetryAdapterConformanceCase` | Grouped case that test runners execute |

## Development

From this package directory:

```bash
npm test
npm run build
```

Repository-wide type checking, formatting, linting, and smoke checks run with:

```bash
npm run check
```

## License

MIT
