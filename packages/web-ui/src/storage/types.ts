import type { AgentMessage, ThinkingLevel } from "@tculpepp/pi-agent-core";
import type { Model } from "@tculpepp/pi-ai";

/**
 * Transaction interface for atomic operations across stores.
 */
export interface StorageTransaction {
	/**
	 * Get a value by key from a specific store.
	 */
	get<T = unknown>(storeName: string, key: string): Promise<T | null>;

	/**
	 * Set a value for a key in a specific store.
	 */
	set<T = unknown>(storeName: string, key: string, value: T): Promise<void>;

	/**
	 * Delete a key from a specific store.
	 */
	delete(storeName: string, key: string): Promise<void>;
}

/**
 * Base interface for all storage backends.
 * Multi-store key-value storage abstraction that can be implemented
 * by IndexedDB, remote APIs, or any other multi-collection storage system.
 */
export interface StorageBackend {
	/**
	 * Get a value by key from a specific store. Returns null if key doesn't exist.
	 */
	get<T = unknown>(storeName: string, key: string): Promise<T | null>;

	/**
	 * Set a value for a key in a specific store.
	 */
	set<T = unknown>(storeName: string, key: string, value: T): Promise<void>;

	/**
	 * Delete a key from a specific store.
	 */
	delete(storeName: string, key: string): Promise<void>;

	/**
	 * Get all keys from a specific store, optionally filtered by prefix.
	 */
	keys(storeName: string, prefix?: string): Promise<string[]>;

	/**
	 * Get all values from a specific store, ordered by an index.
	 * @param storeName - The store to query
	 * @param indexName - The index to use for ordering
	 * @param direction - Sort direction ("asc" or "desc")
	 */
	getAllFromIndex<T = unknown>(storeName: string, indexName: string, direction?: "asc" | "desc"): Promise<T[]>;

	/**
	 * Clear all data from a specific store.
	 */
	clear(storeName: string): Promise<void>;

	/**
	 * Check if a key exists in a specific store.
	 */
	has(storeName: string, key: string): Promise<boolean>;

	/**
	 * Execute atomic operations across multiple stores.
	 */
	transaction<T>(
		storeNames: string[],
		mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T>;

	/**
	 * Get storage quota information.
	 * Used for warning users when approaching limits.
	 */
	getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }>;

	/**
	 * Request persistent storage (prevents eviction).
	 * Returns true if granted, false otherwise.
	 */
	requestPersistence(): Promise<boolean>;
}

/**
 * Lightweight session metadata for listing and searching.
 * Stored separately from full session data for performance.
 */
export interface SessionMetadata {
	/** Unique session identifier (UUID v4) */
	id: string;

	/** User-defined title or auto-generated from first message */
	title: string;

	/** ISO 8601 UTC timestamp of creation */
	createdAt: string;

	/** ISO 8601 UTC timestamp of last modification */
	lastModified: string;

	/** Total number of messages (user + assistant + tool results) */
	messageCount: number;

	/** Cumulative usage statistics */
	usage: {
		/** Total input tokens */
		input: number;
		/** Total output tokens */
		output: number;
		/** Total cache read tokens */
		cacheRead: number;
		/** Total cache write tokens */
		cacheWrite: number;
		/** Total tokens processed */
		totalTokens: number;
		/** Total cost breakdown */
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};

	/** Last used thinking level */
	thinkingLevel: ThinkingLevel;

	/**
	 * Preview text for search and display.
	 * First 2KB of conversation text (user + assistant messages in sequence).
	 * Tool calls and tool results are excluded.
	 */
	preview: string;
}

/**
 * Full session data including all messages.
 * Only loaded when user opens a specific session.
 */
export interface SessionData {
	/** Unique session identifier (UUID v4) */
	id: string;

	/** User-defined title or auto-generated from first message */
	title: string;

	/** Last selected model */
	model: Model<any>;

	/** Last selected thinking level */
	thinkingLevel: ThinkingLevel;

	/** Full conversation history (with attachments inline) */
	messages: AgentMessage[];

	/** ISO 8601 UTC timestamp of creation */
	createdAt: string;

	/** ISO 8601 UTC timestamp of last modification */
	lastModified: string;
}

/**
 * Configuration for IndexedDB backend.
 */
export interface IndexedDBConfig {
	/** Database name */
	dbName: string;
	/** Database version */
	version: number;
	/** Object stores to create */
	stores: StoreConfig[];
}

/**
 * Configuration for an IndexedDB object store.
 */
export interface StoreConfig {
	/** Store name */
	name: string;
	/** Key path (optional, for auto-extracting keys from objects) */
	keyPath?: string;
	/** Auto-increment keys (optional) */
	autoIncrement?: boolean;
	/** Indices to create on this store */
	indices?: IndexConfig[];
}

/**
 * Configuration for an IndexedDB index.
 */
export interface IndexConfig {
	/** Index name */
	name: string;
	/** Key path to index on */
	keyPath: string;
	/** Unique constraint (optional) */
	unique?: boolean;
}
