import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { spamReputation } from "@/db/schema";
import type { ReputationKey } from "./types";

/**
 * Record that the mailbox saw mail from these identities.
 *
 * `spam` marks the message as one the spam engine itself filed into Spam: it
 * counts against the identity as well as being seen, so the same campaign
 * domain is penalized on its next message even before the user reports it.
 * User feedback (applySpamFeedback) is what moves these counts back.
 */
export async function recordReputationObservation(env: CloudflareEnv, mailboxId: string, keys: ReputationKey[], spam = false): Promise<void> {
	// A message analyzed without a fingerprint (e.g. an AI-only verdict when spam
	// protection is off) yields an empty key; recording it would pool unrelated
	// mail under one identity.
	const validKeys = keys.filter((item) => item.key.trim().length > 0);
	if (validKeys.length === 0) return;
	const db = getDb(env);
	const now = new Date();
	await db.batch(validKeys.map((item) => db
		.insert(spamReputation)
		.values({ mailboxId, type: item.type, key: item.key, messagesSeen: 1, spamCount: spam ? 1 : 0, hamCount: 0, firstSeenAt: now, lastSeenAt: now })
		.onConflictDoUpdate({
			target: [spamReputation.mailboxId, spamReputation.type, spamReputation.key],
			set: {
				messagesSeen: sql`${spamReputation.messagesSeen} + 1`,
				...(spam ? { spamCount: sql`${spamReputation.spamCount} + 1` } : {}),
				lastSeenAt: now,
			},
		})) as never);
}
