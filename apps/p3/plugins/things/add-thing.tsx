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
	usePageState,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ComponentType, useRef, useState } from "react";
import { kindOfMakeTick, MAKE_ANY } from "./contract.ts";
import { PluginTitles, ThingParts, useMessageText, useNames, useScreenId } from "./contract.web.tsx";
import type { KindView } from "./kind.ts";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useErrorText, useKinds } from "./use-page.ts";
import { Linkable, Workspace } from "./workspace.ts";

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
	const draft = useDraft(props.workspace);
	const names = useNames();
	// Closed or done, the dialog starts afresh the next time.
	const close = () => {
		draft.clear();
		props.onClose();
	};
	const added = (thing: string) => {
		draft.clear();
		props.onAdded(thing);
	};
	return (
		<Modal.Root onOpenChange={(open) => (open ? undefined : close())} open>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} data-add-thing-dialog="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>
								{t("addToWorkspace", info === undefined ? "" : names.thing(info.kind, info.name))}
							</Modal.Title>
							<Modal.Close render={<IconButton aria-label={t("close")} />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{draft.chosen === undefined ? (
							<Choices onChoose={draft.setChosen} workspace={props.workspace} />
						) : (
							<Confirm
								draft={draft}
								offer={draft.chosen}
								onAdded={added}
								onBack={draft.clear}
								workspace={props.workspace}
							/>
						)}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}

/** What the person removed from the kind's default grants, per party (`DefaultsChoice`'s `without`, before sending). */
type Removed = { readonly everyone: readonly string[]; readonly agents: readonly string[] };

/** Nothing removed. */
const NOTHING_REMOVED: Removed = { everyone: [], agents: [] };

/**
 * The dialog's draft, in page state per workspace (review round 2: a live apply of a plugin keeps it all): the offer
 * chosen, the name, the defaults removed and the create step's last input; `clear` discards it (closed, Back, done).
 */
function useDraft(workspace: string) {
	const key = `things.add.${workspace}`;
	const [chosen, setChosen] = usePageState<Offer | undefined>(`${key}.chosen`, undefined);
	const [name, setName] = usePageState(`${key}.name`, "");
	const [removed, setRemoved] = usePageState(`${key}.removed`, NOTHING_REMOVED);
	const [input, setInput] = usePageState<JsonValue | undefined>(`${key}.input`, undefined);
	const clear = () => {
		setChosen(undefined);
		setName("");
		setRemoved(NOTHING_REMOVED);
		setInput(undefined);
	};
	return { chosen, setChosen, name, setName, removed, setRemoved, input, setInput, clear };
}

/** The dialog's draft (see `useDraft`). */
type Draft = ReturnType<typeof useDraft>;

/** The offers, grouped by plugin, under one search. */
function Choices(props: { readonly workspace: string; readonly onChoose: (offer: Offer) => void }) {
	const { t } = useMessages(page);
	const [query, setQuery] = useState("");
	const kinds = useKinds();
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const makes = useWatch(withGranted(ref, "makes")?.makes);
	// Anyone present may list what could be linked; only a person with Link here is offered those (review round 1).
	const mayLink = withGranted(ref, "link") !== undefined;
	const linkable = useWatch(
		useLive(useHold(Linkable, { workspace: props.workspace, query: query.trim(), view: useScreenId() }))?.list,
	);
	const titles = useRegistry(PluginTitles);
	const names = useNames();
	const text = useMessageText();
	if (kinds === undefined) return null;
	const offers: Offer[] = [];
	for (const name of makes ?? []) {
		const thingKind = kinds.get(name);
		if (thingKind !== undefined && names.kind(name).toLowerCase().includes(query.trim().toLowerCase()))
			offers.push({ kind: "make", thingKind });
	}
	for (const row of mayLink ? (linkable?.rows ?? []) : []) {
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
							<h3 className={styles.pickerTitle}>
								{title === undefined ? names.kind(list[0]!.thingKind.name) : text(title.title)}
							</h3>
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
	const names = useNames();
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
			{offer.kind === "make"
				? t("makeNew", names.kind(offer.thingKind.name))
				: names.thing(offer.thingKind.name, offer.name)}
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
	readonly draft: Draft;
	readonly onAdded: (thing: string) => void;
	readonly onBack: () => void;
}) {
	const { t } = useMessages(page);
	const { offer } = props;
	const { name, setName, removed, setRemoved, input, setInput } = props.draft;
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const maker = withGranted(ref, "make");
	const linker = withGranted(ref, "link");
	const makes = useWatch(withGranted(ref, "makes")?.makes);
	const Create = useRegistry(ThingParts)?.get(offer.thingKind.name)?.value.Create;
	const text = useMessageText();
	const names = useNames();
	const grants = offer.thingKind.defaultGrants;
	// The store writes what the kind or its create hook offers minus `removed` (decision of review round 1), so the
	// preview's list can differ from the offer (a private session) and nothing is refused. Ticked again, a tick is not
	// removed.
	const [pending, setPending] = useState(false);
	// Claimed before the call, not at the next render: two activations before React commits make one call.
	const calling = useRef(false);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const errorText = useErrorText();
	// A Make tick (item 114) reads as what it lets do; a kind's own tick by its label.
	const labelOf = (tick: string) => {
		if (tick === MAKE_ANY) return t("makeAnything");
		const made = kindOfMakeTick(tick);
		if (made !== undefined) return t("makeKind", names.kind(made));
		const found = offer.thingKind.ticks.find((each) => each.name === tick);
		return found === undefined ? tick : text(found.label);
	};
	const toggle = (party: "everyone" | "agents", tick: string, on: boolean) =>
		setRemoved({
			...removed,
			[party]: on ? removed[party].filter((each) => each !== tick) : [...removed[party], tick],
		});
	const without = {
		...(removed.everyone.length === 0 ? {} : { everyone: [...removed.everyone] }),
		...(removed.agents.length === 0 ? {} : { agents: [...removed.agents] }),
	};
	const defaults = Object.keys(without).length === 0 ? {} : { defaults: { without } };
	// The grants are read live: Make of the chosen kind (or Link) taken away while the dialog is open disables Add and
	// says why.
	const allowed =
		offer.kind === "make"
			? maker !== undefined && (makes ?? []).includes(offer.thingKind.name)
			: linker !== undefined;
	const ready = allowed && !pending && (offer.kind === "link" || Create === undefined || input !== undefined);
	const confirm = () => {
		if (!ready || calling.current) return;
		calling.current = true;
		setFailure(undefined);
		setPending(true);
		// `ready` holds only with the reference of the offer's kind: `allowed` checked it.
		const done =
			offer.kind === "make"
				? maker!.make(
						{
							kind: offer.thingKind.name,
							name: name.trim(),
							...(input === undefined ? {} : { input }),
							...defaults,
						},
						BACKGROUND_CONTEXT,
					)
				: linker!.link({ thing: offer.thing, ...defaults }, BACKGROUND_CONTEXT).then(() => offer.thing);
		done.then(
			(thing) => {
				calling.current = false;
				setPending(false);
				props.onAdded(thing);
			},
			(error: unknown) => {
				calling.current = false;
				setPending(false);
				setFailure(errorText(error));
			},
		);
	};
	return (
		<div className={styles.picker} data-add-confirm={offerKey(offer)}>
			{offer.kind === "make" ? (
				<Input data-add-name="" onValueChange={setName} placeholder={t("name")} value={name} />
			) : (
				<strong>{offer.name}</strong>
			)}
			{offer.kind === "make" && Create !== undefined ? (
				<Create input={input} onReady={setInput} workspace={props.workspace} />
			) : null}
			{offer.thingKind.workspace === "no" ? null : (
				// A workspace kind's create hook may answer other default grants (a session: the nearest session defaults).
				<p className={styles.hint} data-add-defaults-note="">
					{t("defaultsMayChange")}
				</p>
			)}
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
										checked={!removed[party].includes(tick)}
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
			{allowed ? null : (
				<p className={styles.error} data-add-not-allowed="">
					{t(offer.kind === "make" ? "mayNotMakeHere" : "mayNotLinkHere")}
				</p>
			)}
			<Modal.Actions>
				<Button hierarchy="tertiary" onClick={props.onBack}>
					{t("back")}
				</Button>
				<Button
					data-add-confirm-button=""
					disabled={!ready}
					hierarchy="primary"
					onClick={confirm}
					pending={pending}
				>
					{t("add")}
				</Button>
			</Modal.Actions>
		</div>
	);
}
