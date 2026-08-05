export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export const Result = {
	ok<TValue>(value: TValue): Result<TValue, never> {
		return { ok: true, value };
	},
	err<TError>(error: TError): Result<never, TError> {
		return { ok: false, error };
	},
	isOk<TValue, TError>(result: Result<TValue, TError>): result is { ok: true; value: TValue } {
		return result.ok;
	},
	isErr<TValue, TError>(result: Result<TValue, TError>): result is { ok: false; error: TError } {
		return !result.ok;
	},
};

export interface TaggedErrorValue<Tag extends string> extends Error {
	readonly _tag: Tag;
	toJSON(): { _tag: Tag; message: string } & Record<string, unknown>;
}

export interface TaggedErrorFactory<Tag extends string> {
	new <Props extends { message: string }>(props: Props): TaggedErrorValue<Tag> & Readonly<Props>;
	is(value: unknown): value is TaggedErrorValue<Tag>;
}

export function TaggedError<Tag extends string>(tag: Tag): TaggedErrorFactory<Tag> {
	class TaggedErrorClass extends Error {
		readonly _tag = tag;

		constructor(props: { message: string } & Record<string, unknown>) {
			super(props.message);
			this.name = tag;
			Object.assign(this, props);
		}

		toJSON(): { _tag: Tag; message: string } & Record<string, unknown> {
			const payload: Record<string, unknown> = {};
			for (const key of Object.keys(this)) {
				if (key !== "_tag") payload[key] = (this as unknown as Record<string, unknown>)[key];
			}
			return { _tag: tag, message: this.message, ...payload };
		}

		static is(value: unknown): value is TaggedErrorValue<Tag> {
			return value instanceof TaggedErrorClass;
		}
	}
	return TaggedErrorClass as unknown as TaggedErrorFactory<Tag>;
}

export type ErrorMatchers<TError extends TaggedErrorValue<string>, TValue> = {
	[Tag in TError["_tag"]]: (error: Extract<TError, { _tag: Tag }>) => TValue;
};

export function matchError<TError extends TaggedErrorValue<string>, TValue>(
	error: TError,
	matchers: ErrorMatchers<TError, TValue>,
): TValue {
	const matcher = (matchers as unknown as Record<string, (value: TError) => TValue>)[error._tag];
	return matcher(error);
}
