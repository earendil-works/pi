import type { SessionRepo } from "../types.ts";

/** A fresh backend instance owned by one conformance case. */
export interface SessionBackendFixture extends AsyncDisposable {
	readonly repository: SessionRepo;
}

/** Creates an isolated fixture for one conformance case. */
export type SessionBackendFixtureFactory = () => Promise<SessionBackendFixture>;

/** A runner-independent conformance case that can be registered with any test framework. */
export interface SessionBackendConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
