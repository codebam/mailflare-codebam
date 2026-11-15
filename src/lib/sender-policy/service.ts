import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { senderPolicies } from "@/db/schema";
import { newId } from "@/lib/ids";
import { isSenderPolicy, isSenderPolicyAddress, normalizeSenderAddress, type SenderPolicy } from "./sender-policy-utils";
import type { SenderPolicyEntry } from "./types";

/**
 * Per-mailbox sender allow/block policy, evaluated before the classifier.
 * Block files mail into Spam (never drops it); allow skips the spam question.
 */

export async function listSenderPolicies(db: AppDatabase, mailboxId: string): Promise<SenderPolicyEntry[]> {
	const rows = await db.select().from(senderPolicies).where(eq(senderPolicies.mailboxId, mailboxId)).orderBy(asc(senderPolicies.address));
	return rows.map((row) => ({ address: row.address, policy: row.policy, createdAt: row.createdAt.toISOString() }));
}

export async function getSenderPolicy(db: AppDatabase, mailboxId: string, address: string): Promise<SenderPolicy | null> {
	const normalized = normalizeSenderAddress(address);
	const [row] = await db.select({ policy: senderPolicies.policy }).from(senderPolicies).where(and(eq(senderPolicies.mailboxId, mailboxId), eq(senderPolicies.address, normalized))).limit(1);
	return row?.policy ?? null;
}

/** Creates or replaces the entry for an address. Throws on invalid input. */
export async function setSenderPolicy(db: AppDatabase, mailboxId: string, address: string, policy: SenderPolicy): Promise<SenderPolicyEntry> {
	const normalized = normalizeSenderAddress(address);
	if (!isSenderPolicyAddress(normalized)) throw new Error("A valid sender email address is required");
	if (!isSenderPolicy(policy)) throw new Error("policy must be allow or block");
	const [existing] = await db.select({ id: senderPolicies.id }).from(senderPolicies).where(and(eq(senderPolicies.mailboxId, mailboxId), eq(senderPolicies.address, normalized))).limit(1);
	if (existing) {
		await db.update(senderPolicies).set({ policy }).where(eq(senderPolicies.id, existing.id));
	} else {
		await db.insert(senderPolicies).values({ id: newId("spol"), mailboxId, address: normalized, policy });
	}
	const [row] = await db.select().from(senderPolicies).where(and(eq(senderPolicies.mailboxId, mailboxId), eq(senderPolicies.address, normalized))).limit(1);
	return { address: row.address, policy: row.policy, createdAt: row.createdAt.toISOString() };
}

export async function removeSenderPolicy(db: AppDatabase, mailboxId: string, address: string): Promise<boolean> {
	const normalized = normalizeSenderAddress(address);
	const [existing] = await db.select({ id: senderPolicies.id }).from(senderPolicies).where(and(eq(senderPolicies.mailboxId, mailboxId), eq(senderPolicies.address, normalized))).limit(1);
	if (!existing) return false;
	await db.delete(senderPolicies).where(eq(senderPolicies.id, existing.id));
	return true;
}