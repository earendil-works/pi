#!/usr/bin/env node
// Orchestra CLI: up | status | goal | spawn | escalations
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { createSupervisor } from "@earendil-works/pi-orchestra-supervisor";
import { renderReport, renderStatus } from "./index.ts";

async function up(dbPath: string): Promise<void> {
	const supervisor = createSupervisor({ config: { dbPath, port: 7788 } });
	await supervisor.listen();
	console.log(`supervisor listening on ${supervisor.supervisorUrl} (db ${dbPath})`);
	console.log("RPC agents: spawn pi --mode rpc -e orchestra-agent-ext/dist/index.js (see docs/ORCHESTRATION.md)");
	// Keep alive; graceful SIGINT
	await new Promise<void>((resolve) => {
		const shutdown = () => {
			void supervisor
				.close()
				.then(() => resolve())
				.catch(() => resolve());
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
}

function status(dbPath: string): void {
	const store = new Store({ path: dbPath });
	try {
		console.log(renderStatus(store));
	} finally {
		store.close();
	}
}

async function main(argv: string[]): Promise<void> {
	const cmd = argv[2] ?? "status";
	const dbPath = process.env.ORCHESTRA_DB ?? join(process.cwd(), ".orchestra/orchestra.db");
	if (cmd === "up") {
		await up(dbPath);
		return;
	}
	if (cmd === "status") {
		status(dbPath);
		return;
	}
	if (cmd === "report") {
		const store = new Store({ path: dbPath });
		try {
			console.log(renderReport(store));
		} finally {
			store.close();
		}
		return;
	}
	if (cmd === "watch") {
		// Read-only live view: one snapshot per second (no typing into panes).
		const agentId = argv[3] ?? "";
		const store = new Store({ path: dbPath });
		try {
			const agent = agentId ? store.getAgent(agentId) : store.listAgents()[0];
			if (!agent) {
				console.log("watch: no agents");
				return;
			}
			const task = agent.taskId ? store.getTask(agent.taskId) : undefined;
			const events = store.recentEvents(agent.id, 5);
			const inbox = store.inbox(agent.id);
			console.log(
				`watch ${agent.name} state=${agent.state} task=${task?.title ?? "—"} thinking=${agent.thinkingLevel}`,
			);
			for (const e of events) console.log(`  event ${e.kind} @${e.ts}`);
			for (const it of inbox.slice(0, 5)) console.log(`  msg ${it.message.type}: ${it.message.body.slice(0, 80)}`);
		} finally {
			store.close();
		}
		return;
	}
	console.log("usage: orchestra up|status|report|watch <agent>");
	console.log(`  ORCHESTRA_DB=${dbPath}`);
}

void main(process.argv);
