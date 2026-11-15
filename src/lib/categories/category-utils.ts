/** Longest category name stored (and accepted). */
export const MAX_CATEGORY_NAME_LENGTH = 50;

/** Most categories one scope (mailbox or instance-wide) can hold. */
export const MAX_CATEGORIES = 100;

/** The mailboxId sentinel for instance-wide categories. */
export const GLOBAL_CATEGORY_SCOPE = "";

export function categoryNameKey(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}