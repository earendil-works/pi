import { contribute, defineFacet } from "@p2/app/v1";
import { closeLayers, SettingsSections, useOwner, useSheet } from "@p2/app/v1/web";
import { EnvsPanel } from "./EnvsPanel.tsx";
import "./style.css";

/** The Environments sheet while it is open (the owner): on its own, or as a page of Settings. */
function EnvsSheet() {
	const sheet = useSheet("envs");
	return useOwner() && sheet ? <EnvsPanel env={sheet.locator} onClose={closeLayers} /> : null;
}

export default defineFacet((host) => {
	contribute(host, "p2.web-envs", (self) => {
		self.contribute(SettingsSections, {
			envs: { label: "Environments", title: "Remote environments", order: 30, Sheet: EnvsSheet },
		});
	});
});
