import type {
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSnapshot,
} from "../types.ts";
import { findSessionEntryMatches } from "./repo-utils.ts";

/** Session 搜索数据源：提供加载和列表能力。 */
type SessionSearchSource<TMetadata extends SessionMetadata> = {
	load(metadata: TMetadata): Promise<SessionSnapshot<TMetadata>>;
	list(): Promise<TMetadata[]>;
};

/**
 * 基于扫描的 session 搜索实现，直接搜索规范 session，无需维护索引。
 * 适合 session 数量较少的场景。
 */
export class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionSearch<TMetadata>
{
	private readonly source: SessionSearchSource<TMetadata>;

	constructor(source: SessionSearchSource<TMetadata>) {
		this.source = source;
	}

	/** 在所有 session 中搜索匹配文本，支持按 cwd 过滤。 */
	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const state = await this.source.load(metadata);
			hits.push(...findSessionEntryMatches(metadata, state.entries, options.text));
		}
		return hits;
	}
}
