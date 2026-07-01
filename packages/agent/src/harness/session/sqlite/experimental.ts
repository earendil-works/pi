export function isExperimentalSqliteSessionStorageEnabled(): boolean {
	return process.env.PI_SQLITE_SESSION_STORAGE === "1";
}
