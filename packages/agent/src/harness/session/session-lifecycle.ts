import type { Session, SessionCreateOptions, SessionForkOptions, SessionMetadata, SessionRepo } from "../types.ts";

export class SessionLifecycle<
	TMetadata extends SessionMetadata,
	TCreateOptions extends SessionCreateOptions,
	TListOptions = void,
> {
	private readonly repo: SessionRepo<TMetadata, TCreateOptions, TListOptions>;

	constructor(options: { repo: SessionRepo<TMetadata, TCreateOptions, TListOptions> }) {
		this.repo = options.repo;
	}

	create(options: TCreateOptions): Promise<Session<TMetadata>> {
		return this.repo.create(options);
	}

	open(metadata: TMetadata): Promise<Session<TMetadata>> {
		return this.repo.open(metadata);
	}

	list(options?: TListOptions): Promise<TMetadata[]> {
		return this.repo.list(options);
	}

	delete(metadata: TMetadata): Promise<void> {
		return this.repo.delete(metadata);
	}

	fork(sourceMetadata: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>> {
		return this.repo.fork(sourceMetadata, options);
	}
}
