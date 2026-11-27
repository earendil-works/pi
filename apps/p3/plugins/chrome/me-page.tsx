// The person's own page, `/me` (decision 74): who they are, then the sections plugins contribute (`MeSections`:
// sign-ins, identities, preferences), each shown only to the person.

import { PageHeader } from "@earendil-works/elanor-react";
import { Me } from "@earendil-works/p3/v1";
import { useHold, useLive, useMessages, useRegistry, useWatch } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web` (see `frame.tsx`).
import { MeSections } from "../things/contract.web.tsx";
import styles from "./frame.module.css";
import { messages } from "./messages.ts";

/** `/me`: the person's name and their sections. */
export function MePage() {
	const { t } = useMessages(messages);
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	const sections = useRegistry(MeSections) ?? [];
	return (
		<div className={styles.me} data-me="">
			<PageHeader.Root>
				<PageHeader.Title level={1}>{me?.kind === "person" ? me.name : t("meTitle")}</PageHeader.Title>
				<PageHeader.Description>{t("meHint")}</PageHeader.Description>
			</PageHeader.Root>
			{sections.map(({ value: { id, Section } }) => (
				<section data-me-section={id} key={id}>
					<Section />
				</section>
			))}
		</div>
	);
}
