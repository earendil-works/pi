import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { useState } from "react";
import type { ResourceSnapshot } from "../../plugins/models/contract.ts";
import { Sheet } from "../runtime/web.tsx";
import { CheckIcon, SearchIcon } from "./icons.tsx";

export type ModelChoice = { model: ModelRef; thinkingLevel: ModelThinkingLevel };
type Summary = ResourceSnapshot["models"][number];

export function modelName(resources: ResourceSnapshot | undefined, model: ModelRef | undefined): string {
	if (!model) return "Choose model";
	return (
		resources?.models.find((entry) => entry.provider === model.provider && entry.modelId === model.modelId)?.name ??
		model.modelId
	);
}

export function thinkingLevels(resources: ResourceSnapshot | undefined, model: ModelRef | undefined): string[] {
	return (
		resources?.models.find((entry) => entry.provider === model?.provider && entry.modelId === model?.modelId)
			?.thinkingLevels ?? ["off"]
	);
}

export function ThinkingControl({
	levels,
	value,
	onChange,
}: {
	levels: string[];
	value: ModelThinkingLevel;
	onChange: (level: ModelThinkingLevel) => void;
}) {
	if (levels.length <= 1) return <p className="muted small">This model has no adjustable thinking.</p>;
	return (
		<fieldset className="segments" aria-label="Thinking level">
			{levels.map((level) => (
				<button
					type="button"
					aria-pressed={value === level}
					key={level}
					className={value === level ? "active" : undefined}
					onClick={() => onChange(level as ModelThinkingLevel)}
				>
					{level}
				</button>
			))}
		</fieldset>
	);
}

/** Picking `model`: the thinking level stays `thinking` where the model has it, else off. */
export function modelChoice(model: Summary, thinking: ModelThinkingLevel | undefined): ModelChoice {
	return {
		model: { provider: model.provider, modelId: model.modelId },
		thinkingLevel: thinking !== undefined && model.thinkingLevels.includes(thinking) ? thinking : "off",
	};
}

export function matchingModels(resources: ResourceSnapshot | undefined, query: string): Summary[] {
	const signedIn = new Set(resources?.credentials.map((credential) => credential.providerId));
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const providerName = new Map(resources?.providers.map((provider) => [provider.id, provider.name]));
	return (resources?.models ?? []).filter(
		(model) =>
			signedIn.has(model.provider) &&
			terms.every((term) =>
				`${model.name} ${model.modelId} ${model.provider} ${providerName.get(model.provider) ?? ""}`
					.toLowerCase()
					.includes(term),
			),
	);
}

export function ModelPicker({
	resources,
	value,
	onChange,
	onDefault,
	onClose,
}: {
	resources?: ResourceSnapshot;
	value: ModelChoice | undefined;
	onChange: (choice: ModelChoice) => void;
	/** Saves the current choice as the default for new sessions. */
	onDefault: (choice: ModelChoice) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const providerName = new Map(resources?.providers.map((provider) => [provider.id, provider.name]));
	const matches = matchingModels(resources, query);
	const groups = new Map<string, Summary[]>();
	for (const model of matches.slice(0, 300)) {
		const group = groups.get(model.provider) ?? [];
		group.push(model);
		groups.set(model.provider, group);
	}
	const levels = thinkingLevels(resources, value?.model);
	const saved = resources?.settings;
	const isDefault =
		value !== undefined &&
		saved?.defaultModel?.provider === value.model.provider &&
		saved.defaultModel.modelId === value.model.modelId &&
		saved.thinkingLevel === value.thinkingLevel;
	return (
		<Sheet title="Model" onClose={onClose}>
			<div className="sheet-sticky">
				{value && (
					<div className="field">
						<span className="label">Thinking</span>
						<ThinkingControl
							levels={levels}
							value={value.thinkingLevel}
							onChange={(thinkingLevel) => onChange({ ...value, thinkingLevel })}
						/>
						{isDefault ? (
							<p className="model-default muted small">Default for new sessions</p>
						) : (
							<button type="button" className="model-default text-action" onClick={() => onDefault(value)}>
								Make default for new sessions
							</button>
						)}
					</div>
				)}
				<label className="search">
					<SearchIcon />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search signed-in models"
						aria-label="Search models"
					/>
				</label>
			</div>
			<div className="model-list">
				{[...groups].map(([provider, models]) => (
					<section key={provider}>
						<h3>{providerName.get(provider) ?? provider}</h3>
						{models.map((model) => {
							const selected = value?.model.provider === model.provider && value.model.modelId === model.modelId;
							return (
								<button
									type="button"
									key={`${model.provider}/${model.modelId}`}
									className={`model-row ${selected ? "selected" : ""}`}
									onClick={() => onChange(modelChoice(model, value?.thinkingLevel))}
								>
									<span>
										<strong>{model.name}</strong>
										<small>
											{model.modelId} · {Math.round(model.contextWindow / 1000)}k
										</small>
									</span>
									{selected && <CheckIcon />}
								</button>
							);
						})}
					</section>
				))}
				{!groups.size && <p className="empty-note">No models match. Only signed-in providers are listed.</p>}
			</div>
		</Sheet>
	);
}
