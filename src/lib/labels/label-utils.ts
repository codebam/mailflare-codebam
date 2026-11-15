/** Longest label name the API and agent tools accept. */
export const LABEL_NAME_MAX_LENGTH = 50;

/** Most labels one mailbox may hold. */
export const LABELS_PER_MAILBOX_MAX = 100;

/** Trimmed and whitespace-collapsed; empty when the name is only whitespace. */
export function normalizeLabelName(name: string): string {
	return name.trim().replace(/\s+/g, " ");
}

/** Case-insensitive uniqueness key, portable across all three dialects. */
export function labelNameKey(name: string): string {
	return normalizeLabelName(name).toLowerCase();
}

/** A #rgb or #rrggbb color token; null (clear) is validated by the caller. */
export function isValidLabelColor(color: string): boolean {
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
}