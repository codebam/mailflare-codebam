import { and, asc, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailboxes, routingRules } from "@/db/schema";
import { newId } from "@/lib/ids";

/**
 * Sender-domain blocks are mailbox routing rules with the native `spam`
 * destination, so they are visible and editable under Settings → Rules and are
 * evaluated before the spam classifier. A whole domain can be blocked without
 * waiting for the classifier to accumulate reports on every new address the
 * campaign uses.
 */

/** Blocks run before the mailbox's ordinary filing rules (which default to priority 10). */
export const SENDER_DOMAIN_BLOCK_PRIORITY = 100;

export type SenderDomainBlock = {
	ruleId: string;
	domain: string;
	enabled: boolean;
	priority: number;
	createdAt: string;
};

/** A DNS-shaped domain: at least two labels, letters/digits/hyphens, optional punycode. */
const DOMAIN_PATTERN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lowercase a domain and reject anything that is not a bare hostname (no address, URL or wildcard). */
export function normalizeSenderDomain(value: string): string {
	const domain = value.trim().toLowerCase().replace(/^@/, "");
	if (!DOMAIN_PATTERN.test(domain)) throw new Error("A valid sender domain is required, for example example.com");
	return domain;
}

function blockWhere(mailboxId: string) {
	return and(
		eq(routingRules.mailboxId, mailboxId),
		eq(routingRules.scope, "mailbox"),
		eq(routingRules.action, "spam"),
		eq(routingRules.matchField, "email"),
		eq(routingRules.matchOperator, "contains"),
	);
}

function toBlock(row: typeof routingRules.$inferSelect): SenderDomainBlock {
	return {
		ruleId: row.id,
		domain: row.matchValue || row.pattern,
		enabled: row.enabled,
		priority: row.priority,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Every sender-domain block in the mailbox, highest priority first. */
export async function listSenderDomainBlocks(db: AppDatabase, mailboxId: string): Promise<SenderDomainBlock[]> {
	const rows = await db.select().from(routingRules).where(blockWhere(mailboxId))
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
	return rows.map(toBlock);
}

/** Create (or re-enable) the block for a domain. Idempotent. */
export async function setSenderDomainBlock(db: AppDatabase, mailboxId: string, value: string): Promise<SenderDomainBlock> {
	const domain = normalizeSenderDomain(value);
	const [mailbox] = await db.select({ userId: mailboxes.userId, domainId: mailboxes.domainId })
		.from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
	if (!mailbox) throw new Error("Mailbox not found");
	const existing = (await db.select().from(routingRules).where(blockWhere(mailboxId))).find((row) => row.matchValue.toLowerCase() === domain);
	if (existing) {
		if (!existing.enabled) await db.update(routingRules).set({ enabled: true }).where(eq(routingRules.id, existing.id));
		return toBlock({ ...existing, enabled: true });
	}
	const id = newId("rule");
	await db.insert(routingRules).values({
		id,
		userId: mailbox.userId,
		domainId: mailbox.domainId,
		scope: "mailbox",
		name: `Block ${domain}`,
		pattern: domain,
		matchField: "email",
		matchOperator: "contains",
		matchValue: domain,
		mailboxId,
		action: "spam",
		priority: SENDER_DOMAIN_BLOCK_PRIORITY,
	});
	const [row] = await db.select().from(routingRules).where(eq(routingRules.id, id)).limit(1);
	return toBlock(row);
}

/** Delete the block for a domain. Returns false when there was nothing to remove. */
export async function removeSenderDomainBlock(db: AppDatabase, mailboxId: string, value: string): Promise<boolean> {
	const domain = normalizeSenderDomain(value);
	const rows = (await db.select({ id: routingRules.id, matchValue: routingRules.matchValue }).from(routingRules).where(blockWhere(mailboxId)))
		.filter((row) => row.matchValue.toLowerCase() === domain);
	if (rows.length === 0) return false;
	for (const row of rows) await db.delete(routingRules).where(eq(routingRules.id, row.id));
	return true;
}
