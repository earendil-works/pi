/**
 * CostLedger - Immutable record of sub-LLM calls with usage and cost
 *
 * Architecture:
 * - SQLite-based ledger in ~/.mu/rlm/ledger.db
 * - Records are immutable (insert-only)
 * - Supports aggregation by session, tool call, and time window
 *
 * Usage:
 * - Record each sub_llm call with usage tokens and calculated cost
 * - Aggregate for reporting and budget enforcement
 */

import { homedir } from "os";
import { join } from "path";

import Database = require("better-sqlite3");

export interface CostEntry {
	callId: string;
	sessionId: string;
	toolCallId: string; // parent code_exec call
	timestamp: number;
	provider: string;
	model: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
	cost: number;
	latencyMs: number;
	success: boolean;
}

export interface CostSummary {
	totalCalls: number;
	totalCost: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	byModel: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number }>;
}

export interface CostBudget {
	maxCostPerCall: number; // USD
	maxCostPerSession: number; // USD
	maxRecursionDepth: number; // sub_llm calling sub_llm
	maxFanout: number; // parallel sub_llm calls
}

export interface BudgetStatus {
	withinBudget: boolean;
	sessionCost: number;
	sessionCalls: number;
	remainingBudget: number;
	violations: string[];
}

export const DEFAULT_BUDGET: CostBudget = {
	maxCostPerCall: 0.5,
	maxCostPerSession: 5.0,
	maxRecursionDepth: 3,
	maxFanout: 10,
};

export interface CostLedgerOptions {
	/** Base directory for ledger database */
	baseDir?: string;
}

const DEFAULT_BASE_DIR = join(homedir(), ".mu", "rlm");

export class CostLedger {
	private db: Database.Database;

	constructor(opts: CostLedgerOptions = {}) {
		const baseDir = opts.baseDir || DEFAULT_BASE_DIR;
		const dbPath = join(baseDir, "ledger.db");

		this.db = new Database(dbPath);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS costs (
        call_id TEXT PRIMARY KEY,
        session_id TEXT,
        tool_call_id TEXT,
        timestamp INTEGER,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost REAL,
        latency_ms INTEGER,
        success INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_costs_session ON costs(session_id);
      CREATE INDEX IF NOT EXISTS idx_costs_tool_call ON costs(tool_call_id);
      CREATE INDEX IF NOT EXISTS idx_costs_timestamp ON costs(timestamp);
    `);
	}

	/**
	 * Record a sub-LLM call (immutable)
	 */
	record(entry: CostEntry): void {
		const stmt = this.db.prepare(`
      INSERT INTO costs (
        call_id, session_id, tool_call_id, timestamp,
        provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost, latency_ms, success
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

		stmt.run(
			entry.callId,
			entry.sessionId,
			entry.toolCallId,
			entry.timestamp,
			entry.provider,
			entry.model,
			entry.usage.inputTokens,
			entry.usage.outputTokens,
			entry.usage.cacheReadTokens || 0,
			entry.usage.cacheWriteTokens || 0,
			entry.cost,
			entry.latencyMs,
			entry.success ? 1 : 0,
		);
	}

	/**
	 * Aggregate costs for session
	 */
	aggregateBySession(sessionId: string): CostSummary {
		const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_calls,
        SUM(cost) as total_cost,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        provider,
        model
      FROM costs
      WHERE session_id = ?
      GROUP BY provider, model
    `);

		const rows = stmt.all(sessionId) as any[];

		const summary: CostSummary = {
			totalCalls: 0,
			totalCost: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			byModel: {},
		};

		for (const row of rows) {
			summary.totalCalls += row.total_calls;
			summary.totalCost += row.total_cost || 0;
			summary.totalInputTokens += row.total_input_tokens || 0;
			summary.totalOutputTokens += row.total_output_tokens || 0;

			const modelKey = `${row.provider}/${row.model}`;
			summary.byModel[modelKey] = {
				calls: row.total_calls,
				cost: row.total_cost || 0,
				inputTokens: row.total_input_tokens || 0,
				outputTokens: row.total_output_tokens || 0,
			};
		}

		return summary;
	}

	/**
	 * Aggregate costs for tool call (parent code_exec)
	 */
	aggregateByToolCall(toolCallId: string): CostSummary {
		const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_calls,
        SUM(cost) as total_cost,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        provider,
        model
      FROM costs
      WHERE tool_call_id = ?
      GROUP BY provider, model
    `);

		const rows = stmt.all(toolCallId) as any[];

		const summary: CostSummary = {
			totalCalls: 0,
			totalCost: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			byModel: {},
		};

		for (const row of rows) {
			summary.totalCalls += row.total_calls;
			summary.totalCost += row.total_cost || 0;
			summary.totalInputTokens += row.total_input_tokens || 0;
			summary.totalOutputTokens += row.total_output_tokens || 0;

			const modelKey = `${row.provider}/${row.model}`;
			summary.byModel[modelKey] = {
				calls: row.total_calls,
				cost: row.total_cost || 0,
				inputTokens: row.total_input_tokens || 0,
				outputTokens: row.total_output_tokens || 0,
			};
		}

		return summary;
	}

	/**
	 * Check if budget exceeded
	 */
	checkBudget(sessionId: string, budget: CostBudget = DEFAULT_BUDGET): BudgetStatus {
		const sessionCost = this.getSessionCost(sessionId);
		const sessionCalls = this.getSessionCallCount(sessionId);

		const violations: string[] = [];

		if (sessionCost >= budget.maxCostPerSession) {
			violations.push(`Session cost $${sessionCost.toFixed(2)} exceeds budget $${budget.maxCostPerSession}`);
		}

		const remainingBudget = Math.max(0, budget.maxCostPerSession - sessionCost);

		return {
			withinBudget: violations.length === 0,
			sessionCost,
			sessionCalls,
			remainingBudget,
			violations,
		};
	}

	/**
	 * Get total cost for session
	 */
	getSessionCost(sessionId: string): number {
		const stmt = this.db.prepare(`SELECT SUM(cost) as total FROM costs WHERE session_id = ?`);
		const row = stmt.get(sessionId) as any;
		return row?.total || 0;
	}

	/**
	 * Get total call count for session
	 */
	getSessionCallCount(sessionId: string): number {
		const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM costs WHERE session_id = ?`);
		const row = stmt.get(sessionId) as any;
		return row?.count || 0;
	}

	/**
	 * Get recent calls for session (for display)
	 */
	getRecentCalls(sessionId: string, limit = 10): CostEntry[] {
		const stmt = this.db.prepare(`
      SELECT * FROM costs
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

		const rows = stmt.all(sessionId, limit) as any[];

		return rows.map((row) => ({
			callId: row.call_id,
			sessionId: row.session_id,
			toolCallId: row.tool_call_id,
			timestamp: row.timestamp,
			provider: row.provider,
			model: row.model,
			usage: {
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				cacheReadTokens: row.cache_read_tokens,
				cacheWriteTokens: row.cache_write_tokens,
			},
			cost: row.cost,
			latencyMs: row.latency_ms,
			success: row.success === 1,
		}));
	}

	/**
	 * Close database connection
	 */
	close(): void {
		this.db.close();
	}
}
