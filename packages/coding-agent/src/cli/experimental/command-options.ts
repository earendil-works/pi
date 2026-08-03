import { type Args, parseArgs } from "../args.ts";
import { type AuthInput, parseAuthInput } from "./auth.ts";
import { type CommandOption, type ParsedCommandInput, stringOption, valueOption } from "./command.ts";
import { parseTransportAddress, type TransportAddress } from "./transport-address.ts";

export const authTokenOption = stringOption("--auth-token");
export const authTokenFileOption = stringOption("--auth-token-file");

export function transportOption(name: "--listen" | "--connect"): CommandOption<TransportAddress> {
	return valueOption(name, (value) => {
		const result = parseTransportAddress(value, name);
		return result.address
			? { ok: true, value: result.address }
			: { ok: false, error: result.error ?? `Invalid ${name} address "${value}"` };
	});
}

export function parseAuth(input: ParsedCommandInput): { auth?: AuthInput; errors: string[] } {
	return parseAuthInput({
		authToken: input.value(authTokenOption),
		authTokenFile: input.value(authTokenFileOption),
	});
}

export function parseLegacyOptions(input: ParsedCommandInput): { options: Args; errors: string[] } {
	const options = parseArgs([...input.remainingArgs]);
	return {
		options,
		errors: options.diagnostics
			.filter((diagnostic) => diagnostic.type === "error")
			.map((diagnostic) => diagnostic.message),
	};
}

export function unsupportedLegacyOptions(command: string, input: ParsedCommandInput): string[] {
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}
