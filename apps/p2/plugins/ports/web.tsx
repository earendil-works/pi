import { contribute, defineFacet } from "@p2/app/v1";
import { ChevronIcon, closeLayers, openLayer, Slots, ToolActivities, useOwner, useSheet } from "@p2/app/v1/web";
import { portsActivity } from "./activity.tsx";
import { PortsPanel } from "./PortsPanel.tsx";

function PortsButton() {
	return (
		<button className="row-button" type="button" onClick={() => openLayer({ kind: "sheet", name: "ports" })}>
			<span>Ports</span>
			<small className="row-value">Open dev servers through Radius</small>
			<ChevronIcon />
		</button>
	);
}
function PortsSheet() {
	const sheet = useSheet("ports");
	return useOwner() && sheet ? <PortsPanel onClose={closeLayers} /> : null;
}
export default defineFacet((host) => {
	contribute(host, "p2.web-ports", (self) => {
		self.contribute(Slots, { "envs-actions:ports": PortsButton, "sidebar-foot:ports": PortsSheet });
		self.contribute(ToolActivities, { ports: portsActivity });
	});
});
