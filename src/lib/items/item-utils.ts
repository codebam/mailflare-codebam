/** Longest item title stored (and accepted). */
export const MAX_ITEM_TITLE_LENGTH = 500;

/** Longest item details stored (and accepted). */
export const MAX_ITEM_DETAILS_LENGTH = 5000;

export const ITEM_KINDS = ["task", "deadline"] as const;
export const ITEM_STATUSES = ["open", "done", "dismissed"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Due bucket relative to `now`, used by the list filter. */
export type ItemDueBucket = "overdue" | "today" | "upcoming" | "none";

export function itemDueBucket(dueAt: Date | null, now: Date): ItemDueBucket {
	if (!dueAt) return "none";
	if (dueAt.getTime() < now.getTime()) return "overdue";
	const endOfDay = new Date(now);
	endOfDay.setHours(23, 59, 59, 999);
	if (dueAt.getTime() <= endOfDay.getTime()) return "today";
	return "upcoming";
}