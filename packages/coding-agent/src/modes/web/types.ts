import type { IncomingMessage, ServerResponse } from "node:http";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "../rpc/rpc-types.js";

export const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
export const TERMINAL_REPLAY_BYTES = 200 * 1024;

export interface WebOptions {
	port: number;
	host: string;
	open: boolean;
	allowRemote: boolean;
	token?: string;
	help?: boolean;
	rpcArgs: string[];
}

export interface WebSessionInfo {
	path: string;
	id?: string;
	cwd?: string;
	name?: string;
	firstMessage?: string;
	modified?: string;
	created?: string;
	messageCount?: number;
}

export interface WebProjectInfo {
	cwd: string;
	sessions: WebSessionInfo[];
	modified?: string;
}

export interface WebSkill {
	name: string;
	description: string;
	meta: Record<string, string>;
	body: string;
	content: string;
	path: string;
	builtin?: boolean;
}

export interface TerminalState {
	cwd: string;
	running: boolean;
	pid: number | null;
	buffer: string;
	exitCode: number | null;
	signal: number | string | null;
	cols: number;
	rows: number;
}

export interface ProgressTrackerTask {
	status: "todo" | "doing" | "done";
	text: string;
}

export interface ProgressTrackerData {
	sessionFile: string;
	path: string;
	tasks: ProgressTrackerTask[];
}

export interface GitChangedLines {
	added: number;
	deleted: number;
	total: number;
}

export interface GitProjectStatus {
	cwd: string;
	isRepo: boolean;
	branch: string | null;
	upstream: string | null;
	hasRemote: boolean;
	ghLoggedIn: boolean;
	githubReady: boolean;
	changedLines: GitChangedLines;
	lastCheckpointAt: string | null;
	lastCheckpointRef: string | null;
	error: string | null;
}

export type WebEvent =
	| Record<string, unknown>
	| {
			type: "web_connected";
			rpcBusy: boolean;
	  }
	| {
			type: "ask_question";
			id: string;
			question: string;
			options: string[];
	  }
	| ({
			type: "progress_tracker";
	  } & ProgressTrackerData)
	| {
			type: "progress_tracker_removed";
			sessionFile: string;
	  }
	| {
			type: "git_status" | "git_checkpoint";
			data: GitProjectStatus;
	  }
	| {
			type: "terminal_start" | "terminal_output" | "terminal_exit";
			cwd: string;
			data?: string;
			pid?: number;
			code?: number | null;
			signal?: number | string | null;
	  };

export type Broadcast = (event: WebEvent) => void;

export type WebRpcCommand = RpcCommand;
export type WebRpcResponse = RpcResponse;
export type WebRpcState = RpcSessionState;
export type WebRpcSlashCommand = RpcSlashCommand;

export interface WebCommand {
	name: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
	sourceInfo?: RpcSlashCommand["sourceInfo"];
}

export interface WebModelsData {
	models: Model<any>[];
}

export interface PromptRequest {
	message: string;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
}

export interface SetModelRequest {
	provider: string;
	modelId: string;
}

export interface SetThinkingRequest {
	level: ThinkingLevel;
}

export interface SwitchSessionRequest {
	sessionPath: string;
}

export interface SkillWriteRequest {
	name: string;
	description: string;
	content: string;
	path?: string;
}

export interface AskQuestionRequest {
	question: string;
	options: string[];
}

export interface ProgressTrackerRequest {
	path: string;
}

export interface GitCommitRequest {
	message: string;
}

export interface AskQuestionAnswer {
	answer: string;
	optionIndex: number | null;
	custom: boolean;
}

export interface SystemPromptRequest {
	systemPrompt: string;
}

export interface TerminalInputRequest {
	data: string;
}

export interface TerminalResizeRequest {
	cols: number;
	rows: number;
}

export interface WebContext {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
}
