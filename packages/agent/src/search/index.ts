export interface SearchQuery {
	text: string;
	limit?: number;
}

export interface SessionSearchHit {
	sessionId: string;
	score?: number;
	top?: { entryId: string; snippet?: string; timestamp: number };
}

export interface EntrySearchHit {
	sessionId: string;
	entryId: string;
	timestamp: number;
	snippet?: string;
	score?: number;
}

export interface SessionSearchService {
	searchSessions(query: SearchQuery): Promise<SessionSearchHit[]>;
	searchEntries?(query: SearchQuery): Promise<EntrySearchHit[]>;
	sync(): Promise<void>;
	notify(sessionId: string): void;
	remove(sessionId: string): Promise<void>;
	close(): Promise<void>;
}
