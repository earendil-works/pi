import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const AUTHORIZATION_SCHEMA_VERSION = 1 as const;

export type AuthorizationEffect = "inspect" | "modify" | "execute" | "administer";
export type GrantScopeKind = "action" | "user-epoch" | "session";

export interface AuthorizationResource {
	kind: string;
	value: string;
}

export interface AuthorizationDescriptor {
	operation: string;
	effect: AuthorizationEffect;
	capabilities: readonly string[];
	resources: readonly AuthorizationResource[];
}

export interface AuthorizationClassificationContext {
	cwd: string;
	repository?: string;
	sessionId: string;
	policyRevision: string;
	toolCallId: string;
}

export type AuthorizationClassifier<TParams = Record<string, unknown>> = {
	bivarianceHack(
		params: Readonly<TParams>,
		context: Readonly<AuthorizationClassificationContext>,
	): AuthorizationDescriptor;
}["bivarianceHack"];

export interface ToolAuthorization<TParams = Record<string, unknown>> {
	operation: string;
	effect: AuthorizationEffect;
	capabilities: readonly string[];
	resources?: readonly AuthorizationResource[];
	classify?: AuthorizationClassifier<TParams>;
}

export interface Capability {
	id: string;
	description: string;
}

export interface ModeProfile {
	id: string;
	capabilities: readonly string[];
	requestableCapabilities: readonly string[];
}

export interface GrantConstraints {
	tools?: readonly string[];
	operations?: readonly string[];
	resources?: readonly AuthorizationResource[];
	actionFingerprint?: string;
}

export interface GrantScope {
	kind: GrantScopeKind;
	sessionId: string;
	epoch?: number;
}

export interface AuthorizationGrant {
	id: string;
	capabilities: readonly string[];
	constraints: Readonly<GrantConstraints>;
	scope: Readonly<GrantScope>;
	issuedAt: number;
	expiresAt?: number;
}

export interface AuthorizationActionSnapshot {
	schemaVersion: typeof AUTHORIZATION_SCHEMA_VERSION;
	fingerprint: string;
	toolCallId: string;
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	cwd: string;
	repository?: string;
	sessionId: string;
	policyRevision: string;
	descriptor: Readonly<AuthorizationDescriptor>;
}

export interface AuthorizationReason {
	code: string;
	message: string;
	policyId?: string;
}

export type AuthorizationDecision =
	| {
			kind: "permit";
			reasons?: readonly AuthorizationReason[];
	  }
	| {
			kind: "require-consent";
			reasons: readonly AuthorizationReason[];
			approval: "action" | "grant";
			eligibleScopes: readonly GrantScopeKind[];
	  }
	| {
			kind: "reject";
			reasons: readonly AuthorizationReason[];
	  };

export interface AuthorizationEvaluationContext {
	grants: readonly AuthorizationGrant[];
}

export interface ToolAuthorizer {
	getPolicyRevision(): string;
	authorize(
		action: Readonly<AuthorizationActionSnapshot>,
		context: Readonly<AuthorizationEvaluationContext>,
	): AuthorizationDecision | Promise<AuthorizationDecision>;
}

export interface CreateAuthorizationActionInput {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	repository?: string;
	sessionId: string;
	policyRevision: string;
	descriptor: AuthorizationDescriptor;
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalize(value: unknown): CanonicalValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Authorization values must contain only finite numbers");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value !== "object") {
		throw new TypeError(`Unsupported authorization value: ${typeof value}`);
	}
	const canonical: { [key: string]: CanonicalValue } = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) canonical[key] = canonicalize(entry);
	}
	return canonical;
}

function immutableClone<T>(value: T): Readonly<T> {
	const clone = structuredClone(value);
	const freeze = (entry: unknown): void => {
		if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
		for (const child of Object.values(entry)) freeze(child);
		Object.freeze(entry);
	};
	freeze(clone);
	return clone;
}

export function fingerprintAuthorizationAction(action: Omit<AuthorizationActionSnapshot, "fingerprint">): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(action)))
		.digest("hex");
}

export function createAuthorizationAction(input: CreateAuthorizationActionInput): AuthorizationActionSnapshot {
	const action = immutableClone({
		schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		input: input.input,
		cwd: resolve(input.cwd),
		...(input.repository ? { repository: resolve(input.repository) } : {}),
		sessionId: input.sessionId,
		policyRevision: input.policyRevision,
		descriptor: input.descriptor,
	});
	return immutableClone({
		...action,
		fingerprint: fingerprintAuthorizationAction(action),
	});
}

export function classifyToolAuthorization<TParams>(
	authorization: ToolAuthorization<TParams>,
	params: Readonly<TParams>,
	context: Readonly<AuthorizationClassificationContext>,
): AuthorizationDescriptor {
	const descriptor = authorization.classify?.(params, context) ?? {
		operation: authorization.operation,
		effect: authorization.effect,
		capabilities: authorization.capabilities,
		resources: authorization.resources ?? [],
	};
	return immutableClone({
		...descriptor,
		capabilities: [...new Set(descriptor.capabilities)].sort(),
		resources: [...descriptor.resources].sort((left, right) =>
			`${left.kind}\u0000${left.value}`.localeCompare(`${right.kind}\u0000${right.value}`),
		),
	});
}
