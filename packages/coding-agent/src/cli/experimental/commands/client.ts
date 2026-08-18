import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export interface ClientCommand {
	readonly command: "client";
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
}

export interface ClientCommandContext {
	runClient(command: ClientCommand): void | Promise<void>;
}

const connectOption = transportOption("--connect");

export const clientCommand = new Command<ClientCommand, ClientCommandContext>("client")
	.option(connectOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const connect = input.value(connectOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("client", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "client",
				...(auth === undefined ? {} : { auth }),
				...(connect === undefined ? {} : { connect }),
			},
		};
	})
	.action((command, context) => context.runClient(command));
