export interface NamedCommandInvocation {
	readonly command: string;
}

export type CommandParseResult<TInvocation extends NamedCommandInvocation = NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

export type CommandExecutionResult<TInvocation extends NamedCommandInvocation = NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

export type CommandOptionParseResult<TValue> =
	| { readonly ok: true; readonly value: TValue }
	| { readonly ok: false; readonly error: string };

export interface CommandOption<TValue> {
	readonly name: `-${string}`;
	readonly flag?: boolean;
	readonly repeatable?: boolean;
	parse(value: string): CommandOptionParseResult<TValue>;
}

export function valueOption<TValue>(
	name: `-${string}`,
	parse: (value: string) => CommandOptionParseResult<TValue>,
	options: { readonly repeatable?: boolean } = {},
): CommandOption<TValue> {
	return { name, parse, ...options };
}

export function stringOption(
	name: `-${string}`,
	options: { readonly repeatable?: boolean } = {},
): CommandOption<string> {
	return valueOption(name, (value) => ({ ok: true, value }), options);
}

export function flagOption(name: `-${string}`): CommandOption<boolean> {
	return { name, flag: true, parse: () => ({ ok: true, value: true }) };
}

export interface ParsedCommandInput {
	readonly remainingArgs: readonly string[];
	value<TValue>(option: CommandOption<TValue>): TValue | undefined;
	values<TValue>(option: CommandOption<TValue>): readonly TValue[];
}

export type CommandBuildResult<TInvocation extends NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

interface MutableParsedCommandInput {
	readonly values: Map<string, unknown[]>;
	readonly remainingArgs: string[];
	readonly errors: string[];
}

type CommandBuilder<TInvocation extends NamedCommandInvocation> = (
	input: ParsedCommandInput,
) => CommandBuildResult<TInvocation>;

type CommandAction<TInvocation extends NamedCommandInvocation, TContext> = (
	command: TInvocation,
	context: TContext,
) => void | Promise<void>;

interface RegisteredCommand {
	parse(argv: readonly string[]): CommandParseResult;
	execute(argv: readonly string[], context: unknown): Promise<CommandExecutionResult>;
}

export class Command<
	TOwnInvocation extends NamedCommandInvocation,
	TContext,
	TInvocation extends NamedCommandInvocation = TOwnInvocation,
> {
	readonly name: string;
	private readonly options = new Map<string, CommandOption<unknown>>();
	private readonly subcommands = new Map<string, RegisteredCommand>();
	private builder?: CommandBuilder<TOwnInvocation>;
	private commandAction?: CommandAction<TOwnInvocation, TContext>;

	constructor(name: string) {
		this.name = name;
	}

	option<TValue>(option: CommandOption<TValue>): this {
		if (this.options.has(option.name)) {
			throw new Error(`Option ${option.name} is already registered for ${this.name}`);
		}
		this.options.set(option.name, option);
		return this;
	}

	build(builder: CommandBuilder<TOwnInvocation>): this {
		this.builder = builder;
		return this;
	}

	action(action: CommandAction<TOwnInvocation, TContext>): this {
		this.commandAction = action;
		return this;
	}

	command<
		TSubcommandOwnInvocation extends NamedCommandInvocation,
		TSubcommandContext,
		TSubcommandInvocation extends NamedCommandInvocation,
	>(
		command: Command<TSubcommandOwnInvocation, TSubcommandContext, TSubcommandInvocation>,
	): Command<TOwnInvocation, TContext & TSubcommandContext, TInvocation | TSubcommandInvocation> {
		if (this.subcommands.has(command.name)) throw new Error(`Command ${command.name} is already registered`);
		this.subcommands.set(command.name, {
			parse: (argv) => command.parse(argv),
			execute: (argv, context) => command.execute(argv, context as TSubcommandContext),
		});
		return this as unknown as Command<
			TOwnInvocation,
			TContext & TSubcommandContext,
			TInvocation | TSubcommandInvocation
		>;
	}

	parse(argv: readonly string[]): CommandParseResult<TInvocation> {
		const selected = this.select(argv);
		if (selected) return selected.command.parse(selected.argv) as CommandParseResult<TInvocation>;
		return this.parseOwn(argv) as CommandParseResult<TInvocation>;
	}

	async execute(argv: readonly string[], context: TContext): Promise<CommandExecutionResult<TInvocation>> {
		const selected = this.select(argv);
		if (selected) {
			return selected.command.execute(selected.argv, context) as Promise<CommandExecutionResult<TInvocation>>;
		}

		const parsed = this.parseOwn(argv);
		if (!parsed.ok) return parsed;
		if (!this.commandAction) throw new Error(`Command ${this.name} does not define an action`);
		await this.commandAction(parsed.command, context);
		return { ok: true, command: parsed.command as unknown as TInvocation };
	}

	private select(argv: readonly string[]): { command: RegisteredCommand; argv: readonly string[] } | undefined {
		const candidate = argv[0];
		if (candidate === undefined) return undefined;
		const command = this.subcommands.get(candidate);
		return command ? { command, argv: argv.slice(1) } : undefined;
	}

	private parseOwn(argv: readonly string[]): CommandParseResult<TOwnInvocation> {
		if (!this.builder) throw new Error(`Command ${this.name} does not define a builder`);
		const parsed = this.parseOptions(argv);
		const input: ParsedCommandInput = {
			remainingArgs: parsed.remainingArgs,
			value: <TValue>(option: CommandOption<TValue>) => parsed.values.get(option.name)?.[0] as TValue | undefined,
			values: <TValue>(option: CommandOption<TValue>) => (parsed.values.get(option.name) ?? []) as readonly TValue[],
		};
		const built = this.builder(input);
		const errors = [...parsed.errors, ...(built.ok ? [] : built.errors)];
		if (errors.length > 0) return { ok: false, errors };
		if (!built.ok) throw new Error(`Command ${this.name} failed without an error`);
		return { ok: true, command: built.command };
	}

	private parseOptions(argv: readonly string[]): MutableParsedCommandInput {
		const parsed: MutableParsedCommandInput = {
			values: new Map(),
			remainingArgs: [],
			errors: [],
		};
		for (let index = 0; index < argv.length; index++) {
			const argument = argv[index]!;
			if (argument === "--") {
				parsed.remainingArgs.push(...argv.slice(index));
				break;
			}

			const equals = argument.indexOf("=");
			const name = equals === -1 ? argument : argument.slice(0, equals);
			const option = this.options.get(name);
			if (!option) {
				parsed.remainingArgs.push(...argv.slice(index));
				break;
			}

			let value: string;
			if (option.flag === true) {
				if (equals !== -1) {
					parsed.errors.push(`${name} does not take a value`);
					continue;
				}
				value = "";
			} else {
				let candidate = equals === -1 ? undefined : argument.slice(equals + 1);
				if (candidate === undefined) {
					const next = argv[index + 1];
					if (next !== undefined && !next.startsWith("-")) {
						candidate = next;
						index++;
					}
				}
				if (candidate === undefined || candidate === "") {
					parsed.errors.push(`${name} requires a value`);
					continue;
				}
				value = candidate;
			}

			const values = parsed.values.get(name) ?? [];
			if (values.length > 0 && option.repeatable !== true) {
				parsed.errors.push(`${name} may only be specified once`);
				continue;
			}
			const result = option.parse(value);
			if (!result.ok) {
				parsed.errors.push(result.error);
				continue;
			}
			values.push(result.value);
			parsed.values.set(name, values);
		}
		return parsed;
	}
}
