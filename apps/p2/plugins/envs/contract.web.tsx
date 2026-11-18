// Web-side contracts of the envs plugin: the location picker other plugins' web facets open (a new session's
// location, moving a session, a new project's folder). It reads the envs plugin's `Envs` object; the recent folders
// come from the sessions its caller passes.
export { DIRECTORY_PICKER, DirectoryPicker, directoryPickerLayer, type LocationUse } from "./DirectoryPicker.tsx";
