# data

Per-call data checks, principals and errors. Pure functions and weak caches; no I/O.

## For apps (`index.ts`)

```ts
import { broken, isChordError } from "./index.ts";

async function open(config: { path?: string }) {
	if (config.path === undefined) throw broken(new Error("notes: no path configured")); // retrying will not help
	// ...
}

try {
	await notes.add({ text: "hi" });
} catch (error) {
	if (isChordError(error, "invalid")) console.log(error.reason, error.message); // e.g. "args", "args/text: missing"
}
```

- `ChordError` with `code`, `reason`, `message`, `details?`; narrowing on `code` narrows `reason`. `isChordError(error,
  code?)`, and the `ChordErrorCode`/`ChordErrorReason` types.
- `Principal` (plain JSON with a `kind`) and `PrincipalKeyFunction`. Apps declare principals as type aliases, not
  interfaces (an interface does not fit `Principal`'s index signature). A custom principal key function must be the
  same on every host; a different one silently splits identities.
- `broken(cause)`: thrown by an open to mark a bad configuration; `FailureCause` is what Chord reports.
- `new PluginError(code, message, details?)`: what a method throws to give its callers a code of its own. On one host
  callers get the thrown value itself; over a link only `code`, `message` and JSON `details` cross and the consumer
  rethrows a PluginError. Any other thrown value crosses as a PluginError with the code `internal` and its message.

## For Chord's layers (`internal.ts`)

- `checkParams(contract, raw, context)`: one compiled closed-object check of a get's params and their key;
  `identityKey(contract, key, principalKey)` (no principal key for `local`); `checkAddress(kind, params, raw,
  context)`: the same check of an address's params against its host kind's (`invalid/placement`), and its key.
- `bindProvider(contract, accepts)` once per registration, then `checkArgs(provider, method, raw, boundVersion,
  context)` per call. It returns `{ kind: "method", args, result? }` (current-shape arguments, and the result mapping
  back to the caller's version) or `{ kind: "call", args, call }` (old arguments for the provider's replacement).
  `Value` is JSON plus bytes.
- `validatorFor(owner, context)`: the compiled validator of a Chord-owned schema, cached weakly by its owner;
  `check(validator, value, reason, context)` runs it (counted) and throws `invalid/<reason>` naming the path (a job's
  args, `jobs/`).
- `principalKey(principal, context, customKey?)`, `canonicalJson(value, context)`.
- `invalid`, `asChordError`, `chordErrorFromJson`, `PROTOCOL_VERSION`, `CHORD_ERROR_REASONS`;
  `openFailure(thrown, label)`.

Rules:

- Params and arguments are the caller's own objects: never copied, frozen or defaulted. A provider must not mutate
  them. Results and state are never checked. Nothing in L1 is frozen.
- A method without arguments (argument schema `null`) omits the argument in references and implementations; `null`
  is its internal and wire form, which `checkArgs` checks. Unknown fields fail.
- A failed check is `invalid/args`, `invalid/params` or `invalid/placement` with `details.path`, a JSON Pointer from TypeBox's first error.
  TypeBox does not escape `~` and `/`, so keys containing them make the path ambiguous.
- `checkArgs` refuses an unknown method with `invalid/member` and an unaccepted version or a refused method with
  `contract_mismatch`. It never invokes a `call` replacement.
- Error codes, reasons and their pairings are link protocol: changing them bumps `PROTOCOL_VERSION`.
- Every function that works takes a required `context` (after the required arguments, before optional ones). Work is
  counted in `chord.data.walks`, `chord.data.validations` and `chord.data.compilations` through its telemetry.
