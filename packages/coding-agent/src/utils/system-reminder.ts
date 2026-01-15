const SYSTEM_REMINDER_TAG_NAME = "system_reminder" as const;

const SYSTEM_REMINDER_TAG_REGEX = new RegExp(
	`<${SYSTEM_REMINDER_TAG_NAME}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${SYSTEM_REMINDER_TAG_NAME}>`,
	"g",
);

export function stripSystemReminderTags(text: string): string {
	return text.replace(SYSTEM_REMINDER_TAG_REGEX, "");
}

export function stripSystemReminderTagsForDisplay(text: string): string {
	const stripped = stripSystemReminderTags(text);
	// Avoid leaving large blank gaps where the hidden tag was.
	return stripped.replace(/\n{3,}/g, "\n\n").trimEnd();
}
