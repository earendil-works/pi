/**
 * Profile management for SDK hosts: a curated re-export of
 * @earendil-works/pi-hub (named pi profiles in ~/.pi/profiles.json plus the
 * per-profile materialized agent dirs — see that package for the file
 * contract). The `pipi` CLI dispatches the same hub module at runtime;
 * bundling it here means an embedding host (e.g. a desktop app) delegates
 * profile management to pi-plus-sdk instead of reimplementing the contract.
 *
 * Deliberately narrow: profiles.json CRUD, materialization, and the shared
 * constants. The materializer's write*File helpers stay internal
 * (materializeProfile is the unit), and hub's CLI command layer
 * (commands.ts/launch.ts) is not part of this surface.
 */

export type { AgentSettingsData, Profile, ProfilesData } from "@earendil-works/pi-hub";
export {
	AGENT_DIR,
	addProfile,
	addProfileModel,
	clearDefaultProfile,
	findProfile,
	getDefaultProfileName,
	loadProfiles,
	materializeProfile,
	profileDirFor,
	removeProfile,
	removeProfileDir,
	removeProfileModel,
	renameProfile,
	setDefaultProfile,
	setProfileDefaultModel,
	syncProfilePackagesToSource,
	THINKING_LEVELS,
	updateProfile,
} from "@earendil-works/pi-hub";
