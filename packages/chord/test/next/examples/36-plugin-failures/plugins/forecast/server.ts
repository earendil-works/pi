// The forecast plugin's server facet: a consumer of the weather plugin's `Weather`.

import { defineFacet, local, str } from "@earendil-works/chord/next";
import { Weather } from "../weather/contract.ts";

const Forecast = local("example.forecast", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) =>
	host.serve(Forecast, (_params, self) => {
		const weather = self.get(Weather, {});
		return { text: self.derive([weather.celsius], ([celsius]) => `${celsius} degrees`) };
	}),
);
