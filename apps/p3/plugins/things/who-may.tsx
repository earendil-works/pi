// Who may do what with a thing here (items 112 to 114): per party an access choice (`@open`: "Can open", "No access",
// or nothing chosen) and one checkbox per tick of the kind (a tick only in rows its `for` matches); on a workspace
// also its Make column (None, All kinds, Only…), folded from the `@make:` ticks. One checkbox is one grant row:
// ticked is given here, (✓) inherited (no row here), crossed out withheld, empty not given; a click writes or deletes
// one row (`Workspace.setTick`). Below the link nothing is given: empty boxes are disabled. A table on wide screens,
// one card per party on a phone: one of the two is rendered, never both.

import { Button, Checkbox, Menu, Popover, SelectionControlAndLabel, Table } from "@earendil-works/elanor-react";
import {
	BACKGROUND_CONTEXT,
	type MessageData,
	type MessagesOf,
	type Translator,
	withGranted,
} from "@earendil-works/p3/v1";
import {
	CancelIcon,
	CheckIcon,
	ChevronRightIcon,
	useHold,
	useLive,
	useMessages,
	useRefState,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { kindOfMakeTick, MAKE_ANY, makeTick, OPEN, type Party, partyKey } from "./contract.ts";
import { useErrorText, useMessageText, useNames } from "./contract.web.tsx";
import type { KindView, TickFor } from "./kind.ts";
import { page } from "./page-messages.ts";
import { audienceOf, isFor, makeTickFor } from "./rules.ts";
import styles from "./things.module.css";
import { useKinds, usePartyName, useWide } from "./use-page.ts";
import { type Cell, WhoMay, Workspace } from "./workspace.ts";

/** What one checkbox shows (item 112). */
type Look = "given" | "inherited" | "withheld" | "empty";

/** What one checkbox shows, from its cell: a giving row here, a withholding row here, the tick by another route, none. */
function lookOf(cell: Cell | undefined): Look {
	if (cell === undefined) return "empty";
	if (cell.here.some((row) => row.gives)) return "given";
	if (cell.here.some((row) => !row.gives)) return "withheld";
	return cell.has ? "inherited" : "empty";
}

/** What a click on a checkbox writes: a reset deletes the row; an inherited tick is withheld; an empty one given. */
function nextGives(look: Look): boolean | undefined {
	switch (look) {
		case "given":
		case "withheld":
			return undefined;
		case "inherited":
			return false;
		case "empty":
			return true;
	}
}

/** One row of the table, as the server sends it. */
type Row = {
	readonly party: Party;
	readonly name: string;
	readonly open: Cell;
	readonly ticks: Readonly<Record<string, Cell>>;
};

/** Who may do what with `thing` in `workspace` (`thing === workspace`: the workspace's own ticks). */
export function WhoMayTable(props: { readonly workspace: string; readonly thing: string; readonly name: string }) {
	const { t } = useMessages(page);
	const whoRef = useHold(WhoMay, { workspace: props.workspace, thing: props.thing });
	const table = useWatch(useLive(whoRef)?.table);
	const state = useRefState(whoRef);
	const nameOf = usePartyName();
	const errorText = useErrorText();
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const setter = withGranted(ref, "setTick");
	const kinds = useKinds();
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const wide = useWide();
	// Who may is held by anyone present (Manage access writes ticks, item 113's grid read-only otherwise); someone
	// not present reads why.
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return (
			<p className={styles.hint} data-who-may-hidden="">
				{t("whoMayHidden")}
			</p>
		);
	}
	if (table === undefined || kinds === undefined) return null;
	const isWorkspace = props.thing === props.workspace;
	const linkedHere = table.linkedIn.kind === "here";
	const set = (party: Party, tick: string, gives: boolean | undefined) => {
		setFailure(undefined);
		setter
			?.setTick({ thing: props.thing, party, tick, ...(gives === undefined ? {} : { gives }) }, BACKGROUND_CONTEXT)
			.catch((error: unknown) => setFailure(errorText(error)));
	};
	// A row's source names a person by their row in this table, when they have one: looked up once per render, not
	// per cell (about 120 rows of 7 cells).
	const names = new Map<string, string>();
	for (const row of table.rows)
		if (row.party.kind === "person" && row.name !== "") names.set(row.party.person, row.name);
	const personName = (person: string) => names.get(person);
	const cellProps = (row: Row): CellProps => ({
		personName,
		row: { ...row, name: nameOf(row.party, row.name) },
		linkedHere,
		belowLink: linkedHere
			? undefined
			: table.linkedIn.kind === "above"
				? t("belowLink", table.linkedIn.name)
				: t("belowLinkUnnamed"),
		onSet:
			setter === undefined ? undefined : (tick: string, gives: boolean | undefined) => set(row.party, tick, gives),
	});
	const forms: FormProps = {
		ticks: table.ticks,
		cells: table.rows.map(cellProps),
		makes: isWorkspace ? kinds : undefined,
	};
	return (
		<section className={styles.whoMay} data-who-may={props.thing}>
			<h2 className={styles.partTitle}>{t("whoMayWith", props.name)}</h2>
			<p className={styles.hint}>{t("whoMayHint")}</p>
			{failure === undefined ? null : (
				<p className={styles.error} data-who-may-failure="">
					{t("failed", failure)}
				</p>
			)}
			{wide ? <WhoMayWide {...forms} /> : <WhoMayCards {...forms} />}
		</section>
	);
}

/** What both forms of who may draw: the kind's ticks, one row's cell props per party, the kinds of a Make column. */
type FormProps = {
	readonly ticks: readonly WhoMayTick[];
	readonly cells: readonly CellProps[];
	/** On a workspace, every kind by name, for its Make column; nothing on a thing. */
	readonly makes: ReadonlyMap<string, KindView> | undefined;
};

/** One tick of the kind, as who may lists it. */
type WhoMayTick = { readonly name: string; readonly label: MessageData; readonly for: TickFor };

/** A tick shows only in the rows of the parties it is for (item 91), by the rule the index gives by (`isFor`). */
function fits(tick: WhoMayTick, row: Row): boolean {
	return isFor(tick.for, audienceOf(row.party.kind));
}

/** Who may on a wide screen: a table, a column per tick under its label. */
function WhoMayWide(props: FormProps) {
	const { t } = useMessages(page);
	const text = useMessageText();
	return (
		<Table.Container>
			<Table.Root>
				<Table.Head>
					<Table.Row>
						<Table.HeaderCell>{t("who")}</Table.HeaderCell>
						<Table.HeaderCell>{t("access")}</Table.HeaderCell>
						{props.makes === undefined ? null : <Table.HeaderCell>{t("make")}</Table.HeaderCell>}
						{props.ticks.map((tick) => (
							<Table.HeaderCell align="center" key={tick.name}>
								{text(tick.label)}
							</Table.HeaderCell>
						))}
					</Table.Row>
				</Table.Head>
				<Table.Body>
					{props.cells.map((cell) => (
						<Table.Row data-who-may-row={partyKey(cell.row.party)} key={partyKey(cell.row.party)}>
							<Table.Cell>
								<Table.CellPrimary>{cell.row.name}</Table.CellPrimary>
							</Table.Cell>
							<Table.Cell>
								<AccessChoice {...cell} />
							</Table.Cell>
							{props.makes === undefined ? null : (
								<Table.Cell>
									<MakeChoice {...cell} kinds={props.makes} />
								</Table.Cell>
							)}
							{props.ticks.map((tick) => (
								<Table.Cell align="center" key={tick.name}>
									{fits(tick, cell.row) ? (
										<TickBox {...cell} label={text(tick.label)} shows="box" tick={tick.name} />
									) : null}
								</Table.Cell>
							))}
						</Table.Row>
					))}
				</Table.Body>
			</Table.Root>
		</Table.Container>
	);
}

/** Who may on a phone: a card per party, each tick with its label. */
function WhoMayCards(props: FormProps) {
	const text = useMessageText();
	return (
		<ul className={styles.cards}>
			{props.cells.map((cell) => (
				<li className={styles.card} data-who-may-row={partyKey(cell.row.party)} key={partyKey(cell.row.party)}>
					<strong>{cell.row.name}</strong>
					<AccessChoice {...cell} />
					{props.makes === undefined ? null : <MakeChoice {...cell} kinds={props.makes} />}
					{props.ticks.map((tick) =>
						fits(tick, cell.row) ? (
							<TickBox {...cell} key={tick.name} label={text(tick.label)} shows="label" tick={tick.name} />
						) : null,
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * What every cell control gets: its row, how a person is named (a row's source), whether the thing is linked here, and
 * the setter (none: read only).
 */
type CellProps = {
	readonly row: Row;
	readonly personName: (person: string) => string | undefined;
	readonly linkedHere: boolean;
	readonly belowLink: string | undefined;
	readonly onSet: ((tick: string, gives: boolean | undefined) => void) | undefined;
};

/**
 * One tick's checkbox, in one of its four looks, named `label`: shown beside it (`shows: "label"`, a phone's card, the
 * Make popup) or only read out (`"box"`, a table cell under its column's heading).
 */
function TickBox(
	props: CellProps & { readonly tick: string; readonly label: string; readonly shows: "label" | "box" },
) {
	const { t } = useMessages(page);
	const look = lookOf(props.row.ticks[props.tick]);
	const disabled = props.onSet === undefined || (look === "empty" && !props.linkedHere);
	const title = look === "empty" && !props.linkedHere ? props.belowLink : t(LOOK_TEXT[look]);
	const box = (
		<Checkbox.Root
			aria-label={`${props.row.name}: ${props.label}`}
			checked={look === "given" || look === "inherited"}
			disabled={disabled}
			onCheckedChange={() => props.onSet?.(props.tick, nextGives(look))}
		>
			<Checkbox.Indicator>{look === "withheld" ? <CancelIcon /> : <CheckIcon />}</Checkbox.Indicator>
		</Checkbox.Root>
	);
	return (
		<span className={styles.tick} data-look={look} data-tick={props.tick} title={title}>
			{props.shows === "box" ? (
				box
			) : (
				<SelectionControlAndLabel control={box}>{props.label}</SelectionControlAndLabel>
			)}
			{look === "withheld" ? <CancelIcon className={styles.withheldMark} /> : null}
			<CellSource cell={props.row.ticks[props.tick]} personName={props.personName} />
		</span>
	);
}

/**
 * Where a cell's rows here come from (the design's "each row's source", tests 6 and 7a): "kind default" for what the
 * kind's plugin wrote at the link (93), the person who wrote it, and "not in effect" for a withholding row whose thing
 * no longer comes from above.
 */
function CellSource(props: {
	readonly cell: Cell | undefined;
	readonly personName: (person: string) => string | undefined;
}) {
	const { t } = useMessages(page);
	const rows = props.cell?.here ?? [];
	if (rows.length === 0) return null;
	const said = rows.map((row) => sourceText(row, props.personName, t));
	return (
		<span
			className={styles.source}
			data-source={rows.map((row) => (row.kindDefault ? "kind-default" : row.source.kind)).join(" ")}
		>
			{said.join(", ")}
		</span>
	);
}

/** What one row here says of where it comes from. */
function sourceText(
	row: Cell["here"][number],
	personName: (person: string) => string | undefined,
	t: Translator<"things.page", MessagesOf<typeof page>>,
): string {
	if (!row.inEffect) return t("notInEffect");
	if (row.kindDefault) return t("kindDefault");
	switch (row.source.kind) {
		case "person": {
			const name = personName(row.source.person);
			return name === undefined ? t("byPerson") : t("byNamed", name);
		}
		case "agent":
			return t("byAgent");
		case "thing":
			return t("byShare");
		case "identity":
			return t("bySignIn");
		case "plugin":
			return t("byPlugin");
	}
}

/** The text each look reads as. */
const LOOK_TEXT = { given: "given", inherited: "inherited", withheld: "withheld", empty: "notGiven" } as const;

/** The access choice (`@open`, item 113): "Can open", "No access", or nothing chosen, "(Can open)" when in anyway. */
function AccessChoice(props: CellProps) {
	const { t } = useMessages(page);
	const look = lookOf(props.row.open);
	const label =
		look === "given"
			? t("canOpen")
			: look === "withheld"
				? t("noAccess")
				: look === "inherited" || Object.values(props.row.ticks).some((cell) => cell.has)
					? t("canOpenInherited")
					: t("accessUnset");
	if (props.onSet === undefined) return <span className={styles.access}>{label}</span>;
	const choose = (gives: boolean | undefined) => props.onSet?.(OPEN, gives);
	return (
		<Menu.Root>
			<Menu.Trigger
				data-access={partyKey(props.row.party)}
				render={<Button density="compact" hierarchy="tertiary" iconEnd={<ChevronRightIcon />} />}
			>
				{label}
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="start" sideOffset={4}>
					<Menu.Popup>
						<Menu.Item data-access-choice="open" disabled={!props.linkedHere} onClick={() => choose(true)}>
							{t("canOpen")}
						</Menu.Item>
						<Menu.Item data-access-choice="none" onClick={() => choose(false)}>
							{t("noAccess")}
						</Menu.Item>
						<Menu.Item data-access-choice="reset" onClick={() => choose(undefined)}>
							{t("accessUnset")}
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

/**
 * The Make column (items 92, 114): a summary ("all kinds", the kinds, "nothing") opening one checkbox for every
 * kind and one for all kinds; kinds whose `makers` exclude the party are named, not offered; a Make tick of a kind
 * that is gone shows greyed as unknown, only to be removed.
 */
function MakeChoice(props: CellProps & { readonly kinds: ReadonlyMap<string, KindView> }) {
	const { t } = useMessages(page);
	const names = useNames();
	const audience = audienceOf(props.row.party.kind);
	const makersOf = (kind: string) => props.kinds.get(kind)?.makers;
	const has = (tick: string) => {
		const look = lookOf(props.row.ticks[tick]);
		return look === "given" || look === "inherited";
	};
	// A kind is offered to the parties its Make tick is for, by the rule a grant is written by (`makeTickFor`).
	const kinds = [...props.kinds.values()];
	const offered = kinds.filter((kind) => isFor(makeTickFor(kind.name, makersOf), audience));
	const peopleOnly = audience === "agents" ? kinds.filter((kind) => kind.makers === "people") : [];
	const unknown = Object.keys(props.row.ticks).filter((tick) => {
		const kind = kindOfMakeTick(tick);
		return kind !== undefined && tick !== MAKE_ANY && !props.kinds.has(kind);
	});
	const summary = has(MAKE_ANY)
		? t("makeAll")
		: offered
				.filter((kind) => has(makeTick(kind)))
				.map((kind) => names.kind(kind.name))
				.join(", ") || t("makeNothing");
	return (
		<Popover.Root>
			<Popover.Trigger
				data-make={partyKey(props.row.party)}
				render={<Button density="compact" hierarchy="secondary" iconEnd={<ChevronRightIcon />} />}
			>
				{summary}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner align="start" sideOffset={4}>
					<Popover.Popup className={styles.makePopup} data-make-popup="">
						<Popover.Title>{t("makeFor", props.row.name)}</Popover.Title>
						<TickBox {...props} label={t("makeAllKinds")} shows="label" tick={MAKE_ANY} />
						{offered.map((kind) => (
							<TickBox
								{...props}
								key={kind.name}
								label={names.kind(kind.name)}
								shows="label"
								tick={makeTick(kind)}
							/>
						))}
						{unknown.map((tick) => (
							<span className={styles.faded} key={tick}>
								<TickBox
									{...props}
									label={t("unknownKind", kindOfMakeTick(tick) ?? tick)}
									shows="label"
									tick={tick}
								/>
							</span>
						))}
						{peopleOnly.length === 0 ? null : (
							<p
								className={styles.hint}
							>{`${t("peopleOnly")} ${peopleOnly.map((kind) => names.kind(kind.name)).join(", ")}`}</p>
						)}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
