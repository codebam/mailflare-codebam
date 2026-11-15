/** Policy values accepted by the API and stored in sender_policies. */
export const SENDER_POLICIES = ["allow", "block"] as const;

export type SenderPolicy = (typeof SENDER_POLICIES)[number];

export function isSenderPolicy(value: unknown): value is SenderPolicy {
	return typeof value === "string" && (SENDER_POLICIES as readonly string[]).includes(value);
}

/**
 * Bare address, trimmed + lowercased, so `Alice@Example.com ` and
 * `alice@example.com` are the same entry. Display names are stripped.
 */
export function normalizeSenderAddress(value: string): string {
	const trimmed = value.trim();
	const angled = trimmed.match(/<([^>]+)>/);
	const bare = (angled ? angled[1] : trimmed).trim().toLowerCase();
	return bare;
}

/** A bare address worth storing: one @, no spaces, bounded length. */
export function isSenderPolicyAddress(value: string): boolean {
	return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) && value.length <= 320;
}