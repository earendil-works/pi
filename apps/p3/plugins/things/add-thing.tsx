// The add-thing picker (R22, items 61, 93): grouped by the plugin a kind comes from, per plugin the kinds the caller
// may make here (`Workspace.makes`) and its things the caller may link (`Linkable`); a plugin with one thing to offer
// is a plain row; one search over all. Choosing one shows its name, the kind's create step if it has one, and its
// default grants in plain words, each with a tick the person may remove; confirming makes or links it with what is
// left ticked.

import {
	Button,
	Checkbox,
	IconButton,
	Input,
	Modal,
	SelectionControlAndLabel,
	Stack,
} from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type JsonValue, withGranted } from "@earendil-works/p3/v1";
import {
	CloseIcon,
	DescriptionIcon,
	LinkIcon,
	useHold,
	useLive,
	useMessages,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ComponentType, useState } from "react";
import { kindOfMakeTick, MAKE_ANY } from "./contract.ts";
import { PluginTitles, ThingParts, useScreenId } from "./contract.web.tsx";
import type { KindView } from "./kind.ts";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useErrorText, useKinds, useMessageText } from "./use-page.ts";
import { type DefaultsChoice, Linkable, Workspace } from "./workspace.ts";

/** What the picker offers: a kind to make, or an existing thing to link. */
type Offer =
	| { readonly kind: "make"; readonly thingKind: KindView }
	| { readonly kind: "link"; readonly thing: string; readonly name: string; readonly thingKind: KindView };

/** The picker of `workspace`, as a dialog; `onAdded` gets the thing made or linked. */
export function AddThingDialog(props: {
	readonly workspace: string;
	readonly onAdded: (thing: string) => void;
	readonly onClose: () => void;
}) {
	const { t } = useMessages(page);
	const info = useWatch(useLive(useHold(Workspace, { workspace: props.workspace }))?.info);
	const [chosen, setChosen] = useState<Offer | undefined>(undefined);
	return (
		<Modal.Root onOpenChange={(open) => (open ? undefined : props.onClose())} open>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} data-add-thing-dialog="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>{t("addToWorkspace", info?.name ?? "")}</Modal.Title>
							<Modal.Close render={<IconButton aria-label={t("close")} />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{chosen === undefined ? (
							<Choices onChoose={setChosen} workspace={props.workspace} />
						) : (
							<Confirm
								offer={chosen}
								onAdded={props.onAdded}
								onBack={() => setChosen(undefined)}
								workspace={props.workspace}
							/>
						)}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}

/** The offers, grouped by plugin, under one search. */
function Choices(props: { readonly workspace: string; readonly onChoose: (offer: Offer) => void }) {
	const { t } = useMessages(page);
	const [query, setQuery] = useState("");
	const kinds = useKinds();
	const makes = useWatch(withGranted(useLive(useHold(Workspace, { workspace: props.workspace })), "makes")?.makes);
	const linkable = useWatch(
		useLive(useHold(Linkable, { workspace: props.workspace, query: query.trim(), view: useScreenId() }))?.list,
	);
	const titles = useRegistry(PluginTitles);
	const text = useMessageText();
	if (kinds === undefined) return null;
	const offers: Offer[] = [];
	for (const name of makes ?? []) {
		const thingKind = kinds.get(name);
		if (thingKind !== undefined && name.includes(query.trim().toLowerCase()))
			offers.push({ kind: "make", thingKind });
	}
	for (const row of linkable?.rows ?? []) {
		const thingKind = kinds.get(row.kind);
		if (thingKind !== undefined) offers.push({ kind: "link", thing: row.thing, name: row.name, thingKind });
	}
	const byPlugin = new Map<string, Offer[]>();
	for (const offer of offers) {
		const plugin = offer.thingKind.plugin;
		const list = byPlugin.get(plugin) ?? [];
		list.push(offer);
		byPlugin.set(plugin, list);
	}
	return (
		<div className={styles.picker}>
			<Input data-add-search="" onValueChange={setQuery} placeholder={t("search")} value={query} />
			{[...byPlugin].map(([plugin, list]) => {
				const title = titles?.get(plugin)?.value;
				return (
					<section className={styles.pickerGroup} data-add-plugin={plugin} key={plugin}>
						{list.length > 1 ? (
							<h3 className={styles.pickerTitle}>{title === undefined ? plugin : text(title.title)}</h3>
						) : null}
						{list.map((offer) => (
							<OfferRow key={offerKey(offer)} offer={offer} onChoose={props.onChoose} />
						))}
					</section>
				);
			})}
		</div>
	);
}

/** One offer: "New <kind>" or an existing thing's name, with its kind's icon. */
function OfferRow(props: { readonly offer: Offer; readonly onChoose: (offer: Offer) => void }) {
	const { t } = useMessages(page);
	const { offer } = props;
	const Icon: ComponentType = useRegistry(ThingParts)?.get(offer.thingKind.name)?.value.Icon ?? DescriptionIcon;
	return (
		<Button
			className={styles.offer}
			data-add-offer={offerKey(offer)}
			hierarchy="tertiary"
			iconEnd={offer.kind === "link" ? <LinkIcon /> : undefined}
			iconStart={<Icon />}
			onClick={() => props.onChoose(offer)}
		>
			{offer.kind === "make" ? t("makeNew", offer.thingKind.name) : offer.name}
		</Button>
	);
}

/** An offer's key: `make:<kind>` or `link:<thing>`. */
function offerKey(offer: Offer): string {
	return offer.kind === "make" ? `make:${offer.thingKind.name}` : `link:${offer.thing}`;
}

/** The chosen offer: its name and create step (a new thing), its default grants to keep, and the confirmation. */
function Confirm(props: {
	readonly workspace: string;
	readonly offer: Offer;
	readonly onAdded: (thing: string) => void;
	readonly onBack: () => void;
}) {
	const { t } = useMessages(page);
	const { offer } = props;
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const maker = withGranted(ref, "make");
	const linker = withGranted(ref, "link");
	const Create = useRegistry(ThingParts)?.get(offer.thingKind.name)?.value.Create;
	const text = useMessageText();
	const [name, setName] = useState("");
	const [input, setInput] = useState<JsonValue | undefined>(undefined);
	const grants = offer.thingKind.defaultGrants;
	const [kept, setKept] = useState<DefaultsChoice>({
		everyone: [...(grants.everyone ?? [])],
		agents: [...(grants.agents ?? [])],
	});
	// Whether the person changed the defaults: untouched, none are sent and the kind (or its create hook, which may
	// answer other ones, a private workspace's) decides.
	const [touched, setTouched] = useState(false);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const errorText = useErrorText();
	// A Make tick (item 114) reads as what it lets do; a kind's own tick by its label.
	const labelOf = (tick: string) => {
		if (tick === MAKE_ANY) return t("makeAnything");
		const made = kindOfMakeTick(tick);
		if (made !== undefined) return t("makeKind", made);
		const found = offer.thingKind.ticks.find((each) => each.name === tick);
		return found === undefined ? tick : text(found.label);
	};
	const toggle = (party: "everyone" | "agents", tick: string, on: boolean) => {
		setTouched(true);
		setKept({ ...kept, [party]: on ? [...kept[party], tick] : kept[party].filter((each) => each !== tick) });
	};
	const defaults = touched ? { defaults: kept } : {};
	const ready = offer.kind === "link" || Create === undefined || input !== undefined;
	const confirm = () => {
		setFailure(undefined);
		const done =
			offer.kind === "make"
				? maker?.make(
						{
							kind: offer.thingKind.name,
							name: name.trim(),
							...(input === undefined ? {} : { input }),
							...defaults,
						},
						BACKGROUND_CONTEXT,
					)
				: linker?.link({ thing: offer.thing, ...defaults }, BACKGROUND_CONTEXT).then(() => offer.thing);
		done?.then(props.onAdded, (error: unknown) => setFailure(errorText(error)));
	};
	return (
		<div className={styles.picker} data-add-confirm={offerKey(offer)}>
			{offer.kind === "make" ? (
				<Input data-add-name="" onValueChange={setName} placeholder={t("name")} value={name} />
			) : (
				<strong>{offer.name}</strong>
			)}
			{offer.kind === "make" && Create !== undefined ? (
				<Create onReady={setInput} workspace={props.workspace} />
			) : null}
			{(["everyone", "agents"] as const).map((party) =>
				(grants[party] ?? []).length === 0 ? null : (
					<div className={styles.preview} data-add-defaults={party} key={party}>
						<p>
							{t(
								party === "everyone" ? "everyoneMay" : "agentsMay",
								(grants[party] ?? []).map(labelOf).join(", "),
							)}
						</p>
						{(grants[party] ?? []).map((tick) => (
							<SelectionControlAndLabel
								control={
									<Checkbox.Root
										checked={kept[party].includes(tick)}
										data-add-default={`${party}/${tick}`}
										onCheckedChange={(on) => toggle(party, tick, on)}
									>
										<Checkbox.Indicator />
									</Checkbox.Root>
								}
								key={tick}
							>
								{labelOf(tick)}
							</SelectionControlAndLabel>
						))}
					</div>
				),
			)}
			{failure === undefined ? null : <p className={styles.error}>{t("failed", failure)}</p>}
			<Modal.Actions>
				<Button hierarchy="tertiary" onClick={props.onBack}>
					{t("back")}
				</Button>
				<Button data-add-confirm-button="" disabled={!ready} hierarchy="primary" onClick={confirm}>
					{t("add")}
				</Button>
			</Modal.Actions>
		</div>
	);
}
