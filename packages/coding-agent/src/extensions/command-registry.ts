import type { ExtensionCommand } from "./types.js";

export interface CommandRegistrationMeta {
	sourceId: string;
	priority?: number;
}

interface CommandRegistration {
	command: ExtensionCommand;
	sourceId: string;
	priority: number;
	seq: number;
}

function pickActive(registrations: CommandRegistration[]): CommandRegistration | undefined {
	if (registrations.length === 0) return undefined;
	return registrations.slice().sort((a, b) => b.priority - a.priority || b.seq - a.seq)[0];
}

export class CommandRegistry {
	private registrationsByName = new Map<string, CommandRegistration[]>();
	private seq = 0;

	registerCommand(command: ExtensionCommand, meta: CommandRegistrationMeta): void {
		const name = command.name;
		const regs = this.registrationsByName.get(name) ?? [];

		regs.push({
			command,
			sourceId: meta.sourceId,
			priority: meta.priority ?? 0,
			seq: this.seq++,
		});

		this.registrationsByName.set(name, regs);
	}

	getCommand(name: string): ExtensionCommand | undefined {
		const regs = this.registrationsByName.get(name);
		const active = regs ? pickActive(regs) : undefined;
		return active?.command;
	}

	listCommands(): ExtensionCommand[] {
		const names = Array.from(this.registrationsByName.keys()).sort();
		const commands: ExtensionCommand[] = [];
		for (const name of names) {
			const cmd = this.getCommand(name);
			if (cmd) commands.push(cmd);
		}
		return commands;
	}

	unregisterBySourceId(sourceId: string): void {
		for (const [name, regs] of this.registrationsByName) {
			const kept = regs.filter((r) => r.sourceId !== sourceId);
			if (kept.length === 0) {
				this.registrationsByName.delete(name);
			} else {
				this.registrationsByName.set(name, kept);
			}
		}
	}
}
