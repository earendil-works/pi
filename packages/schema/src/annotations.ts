// Annotation tracking for `unevaluatedProperties` and `unevaluatedItems`: annotating checks record which
// properties and items a schema evaluated. Only schemas that use those keywords compile into these closures.

import { isObject } from "./checks.ts";
import type { Check } from "./types.ts";

/** What a schema evaluated: property names (or all of them), the evaluated item prefix, items matched by `contains`. */
export interface Annotations {
	props: Set<string> | null;
	allProps: boolean;
	items: number;
	allItems: boolean;
	indexes: Set<number> | null;
}

/** A check that records what it evaluated into `a` when it passes. */
export type AnnotatingCheck = (value: unknown, a: Annotations) => boolean;

/** Empty annotations. */
export function newAnnotations(): Annotations {
	return { props: null, allProps: false, items: 0, allItems: false, indexes: null };
}

function merge(a: Annotations, b: Annotations): void {
	if (b.props !== null) for (const k of b.props) addProp(a, k);
	a.allProps ||= b.allProps;
	if (b.items > a.items) a.items = b.items;
	a.allItems ||= b.allItems;
	if (b.indexes !== null) for (const i of b.indexes) addIndex(a, i);
}

function addProp(a: Annotations, key: string): void {
	if (a.props === null) a.props = new Set();
	a.props.add(key);
}

function addIndex(a: Annotations, index: number): void {
	if (a.indexes === null) a.indexes = new Set();
	a.indexes.add(index);
}

export const ANNOTATING_TRUE: AnnotatingCheck = () => true;
export const ANNOTATING_FALSE: AnnotatingCheck = () => false;

/** The indirection a recursive reference goes through. */
export function indirectAnnotating(slot: { check: AnnotatingCheck | undefined }): AnnotatingCheck {
	return (v, a) => (slot.check as AnnotatingCheck)(v, a);
}

/** A plain check in annotating position: it evaluates nothing that unevaluated* sees. */
export function ignoreAnnotations(check: Check): AnnotatingCheck {
	return (v) => check(v);
}

/** An annotating check run as a plain check, with fresh annotations. */
export function withFreshAnnotations(check: AnnotatingCheck): Check {
	return (v) => check(v, newAnnotations());
}

/** `check` with `uri` pushed onto the dynamic scope while it runs. */
export function scopedAnnotating(scope: string[], uri: string, check: AnnotatingCheck): AnnotatingCheck {
	return (v, a) => {
		scope.push(uri);
		const ok = check(v, a);
		scope.pop();
		return ok;
	};
}

/** unevaluated* sees only the annotations of its own schema, never those of its siblings in the parent. */
export function isolateAnnotations(check: AnnotatingCheck): AnnotatingCheck {
	return (v, a) => {
		const b = newAnnotations();
		if (!check(v, b)) return false;
		merge(a, b);
		return true;
	};
}

/** The non-annotating keywords, then each annotating part in order. */
export function annotateAll(plain: Check, parts: readonly AnnotatingCheck[]): AnnotatingCheck {
	return (v, a) => {
		if (!plain(v)) return false;
		for (let i = 0; i < parts.length; i++) if (!parts[i](v, a)) return false;
		return true;
	};
}

/** `properties`, `patternProperties` and `additionalProperties`. */
export function annotateObject(
	props: readonly (readonly [string, Check])[],
	patterns: readonly (readonly [RegExp, Check])[],
	additional: Check | undefined,
): AnnotatingCheck {
	const declared = new Set(props.map(([k]) => k));
	return (v, a) => {
		if (!isObject(v)) return true;
		const seen: string[] = [];
		for (const [k, check] of props) {
			if (!Object.hasOwn(v, k)) continue;
			if (!check(v[k])) return false;
			seen.push(k);
		}
		for (const k of Object.keys(v)) {
			let matched = declared.has(k);
			for (const [re, check] of patterns) {
				if (re.test(k)) {
					if (!check(v[k])) return false;
					matched = true;
					seen.push(k);
				}
			}
			if (!matched && additional !== undefined) {
				if (!additional(v[k])) return false;
				seen.push(k);
			}
		}
		for (const k of seen) addProp(a, k);
		return true;
	};
}

/** `prefixItems`/`items`/`additionalItems` and `contains` with its bounds. */
export function annotateArray(
	prefix: readonly Check[],
	rest: Check | undefined,
	contains: Check | undefined,
	minContains: number,
	maxContains: number,
): AnnotatingCheck {
	return (v, a) => {
		if (!Array.isArray(v)) return true;
		const m = Math.min(v.length, prefix.length);
		for (let i = 0; i < m; i++) if (!prefix[i](v[i])) return false;
		if (rest !== undefined) {
			for (let i = prefix.length; i < v.length; i++) if (!rest(v[i])) return false;
			a.allItems = true;
		}
		if (m > a.items) a.items = m;
		if (contains !== undefined) {
			let n = 0;
			for (let i = 0; i < v.length; i++) {
				if (contains(v[i])) {
					n++;
					addIndex(a, i);
				}
			}
			if (n < minContains || n > maxContains) return false;
		}
		return true;
	};
}

/** `anyOf` (or `oneOf` when `exactlyOne`): every passing branch contributes its annotations. */
export function annotateAny(branches: readonly AnnotatingCheck[], exactlyOne: boolean): AnnotatingCheck {
	return (v, a) => {
		let n = 0;
		for (const branch of branches) {
			const b = newAnnotations();
			if (branch(v, b)) {
				n++;
				merge(a, b);
			}
		}
		return exactlyOne ? n === 1 : n > 0;
	};
}

/** `if`, `then` and `else`: a passing `if` contributes its annotations even without `then`. */
export function annotateIf(
	cond: AnnotatingCheck,
	then: AnnotatingCheck | undefined,
	otherwise: AnnotatingCheck | undefined,
): AnnotatingCheck {
	return (v, a) => {
		const b = newAnnotations();
		if (cond(v, b)) {
			merge(a, b);
			return then === undefined || then(v, a);
		}
		return otherwise === undefined || otherwise(v, a);
	};
}

/** One `dependentSchemas` entry. */
export function annotateDependent(key: string, check: AnnotatingCheck): AnnotatingCheck {
	return (v, a) => !isObject(v) || !Object.hasOwn(v, key) || check(v, a);
}

/** `unevaluatedProperties`: every property no other keyword evaluated passes `check`. */
export function unevaluatedProperties(check: Check): AnnotatingCheck {
	return (v, a) => {
		if (!isObject(v) || a.allProps) return true;
		for (const k of Object.keys(v)) if (!(a.props?.has(k) ?? false) && !check(v[k])) return false;
		a.allProps = true;
		return true;
	};
}

/** `unevaluatedItems`: every item no other keyword evaluated passes `check`. */
export function unevaluatedItems(check: Check): AnnotatingCheck {
	return (v, a) => {
		if (!Array.isArray(v) || a.allItems) return true;
		for (let i = a.items; i < v.length; i++) if (!(a.indexes?.has(i) ?? false) && !check(v[i])) return false;
		a.allItems = true;
		return true;
	};
}
