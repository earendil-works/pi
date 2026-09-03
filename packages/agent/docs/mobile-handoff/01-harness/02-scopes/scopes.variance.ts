/**
 * Executable form of scopes.md §6.
 *
 *   npx tsc --noEmit --strict --lib es2023 scopes.variance.ts
 *
 * Silence means the rule holds: reads accept either scope, single-scope commits
 * pass, and mixed-scope commits are the ONLY thing rejected. The three
 * `@ts-expect-error` lines fail the compile if they ever start type-checking,
 * so this catches the enforcement being weakened as well as broken.
 *
 * The variance split is the part that is easy to get backwards. Making addresses
 * invariant too breaks every reader — getValue, scanValues, readList and
 * everything downstream — and the tempting fix, making each reader generic over
 * Sc, propagates a type parameter through the whole storage stack to express
 * what variance gives for free.
 */
declare const tag: unique symbol;
type SessionScope = { readonly kind: "session" };
type EphemeralScope = { readonly kind: "ephemeral" };
type Scope = SessionScope | EphemeralScope;

/** Addresses: COVARIANT — Sc only in return position. Readers take any scope. */
interface ScopedAddress<Sc extends Scope> { readonly [tag]?: () => Sc }
/** Writes: INVARIANT — Sc in both positions. Mixed commits cannot unify. */
interface Scoped<Sc extends Scope> { readonly [tag]?: (s: Sc) => Sc }

interface Value<T, Sc extends Scope = SessionScope> extends ScopedAddress<Sc> { k: "v" }
interface ValueList<T, Sc extends Scope = SessionScope> extends ScopedAddress<Sc> { k: "l" }
interface VSet<Sc extends Scope = Scope> extends Scoped<Sc> { kind: "value"; op: "set" }
interface VDel<Sc extends Scope = Scope> extends Scoped<Sc> { kind: "value"; op: "delete" }
interface LApp<Sc extends Scope = Scope> extends Scoped<Sc> { kind: "list"; op: "append" }
interface EntryWrite { kind: "entry" }
interface RetireWrite extends Scoped<SessionScope> { kind: "scope" }

type Write<Sc extends Scope = SessionScope> =
  | VSet<Sc> | VDel<Sc> | LApp<Sc>
  | (Sc extends SessionScope ? EntryWrite | RetireWrite : never);

declare function setValue<T, Sc extends Scope>(a: Value<T, Sc>, v: T): VSet<Sc>;
declare function deleteValue<T, Sc extends Scope>(a: Value<T, Sc>): VDel<Sc>;
declare function appendList<T, Sc extends Scope>(a: ValueList<T, Sc>, v: T): LApp<Sc>;
declare function retireScope(id: string): RetireWrite;
declare function insertEntry(e: unknown): EntryWrite;
declare function commit<Sc extends Scope = SessionScope>(w: readonly Write<Sc>[]): void;
declare function getValue<T>(a: Value<T, Scope>): T;              // reader: any scope

const laneState = null as unknown as Value<string>;                          // session
const pendingOut = null as unknown as ValueList<string, EphemeralScope>;     // ephemeral
const toolMemo = null as unknown as Value<string, EphemeralScope>;

// READS accept either scope — that is what covariance buys.
getValue(laneState);
getValue(toolMemo);

// Single-scope commits pass.
commit([setValue(laneState, "a")]);
commit([setValue(laneState, "a"), insertEntry({}), retireScope("op_1")]);
commit([appendList(pendingOut, "x"), setValue(toolMemo, "m")]);

// @ts-expect-error mixed scopes in one transaction
commit([setValue(laneState, "a"), appendList(pendingOut, "x")]);
// @ts-expect-error a retire is session-only, so it cannot join an ephemeral commit
commit([appendList(pendingOut, "x"), retireScope("op_1")]);
// @ts-expect-error entries are session-only
commit<EphemeralScope>([insertEntry({})]);
