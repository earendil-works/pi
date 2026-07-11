import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getInstancesPath, getMachinePath, getOrchestratorDir } from "./config.ts";
import type { InstanceRecord, MachineRecord } from "./types.ts";

function ensureOrchestratorDir(): void {
	const orchestratorDir = getOrchestratorDir();
	if (!existsSync(orchestratorDir)) {
		mkdirSync(orchestratorDir, { recursive: true });
	}
}

export function loadMachine(): MachineRecord | undefined {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return undefined;
	}

	const data = readFileSync(machinePath, "utf-8");
	return JSON.parse(data) as MachineRecord;
}

export function saveMachine(machine: MachineRecord): void {
	ensureOrchestratorDir();
	writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return;
	}
	rmSync(machinePath);
}

export function loadInstances(): InstanceRecord[] {
	const instancesPath = getInstancesPath();
	if (!existsSync(instancesPath)) {
		return [];
	}

	const data = readFileSync(instancesPath, "utf-8");
	return JSON.parse(data) as InstanceRecord[];
}

export function saveInstances(instances: InstanceRecord[]): void {
	ensureOrchestratorDir();
	writeFileSync(getInstancesPath(), JSON.stringify(instances, null, 2));
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}
