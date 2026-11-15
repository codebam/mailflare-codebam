import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, routingRules } from "@/db/schema";
import { newId } from "@/lib/ids";

/**
 * Catch-all provisioning, adapted from agentic-inbox's per-domain catch-all
 * mailbox. Mailflare's routing already gives real mailboxes precedence over
 * catch-all rules; this creates the `catch-all@<domain>` mailbox and the
 * domain-scope store rule with the "*" pattern, idempotently.
 */
export async function ensureCatchAllMailbox(db: AppDatabase, domainId: string): Promise<{ mailboxId: string; address: string; created: boolean }> {
	const [domain] = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
	if (!domain) throw new Error("Domain not found");
	const existing = await db.select().from(mailboxes).where(eq(mailboxes.domainId, domainId));
	let catchAll = existing.find((mailbox) => mailbox.localPart.toLowerCase() === "catch-all");
	let created = false;
	if (!catchAll) {
		const id = newId("mbx");
		await db.insert(mailboxes).values({ id, userId: domain.userId, domainId, localPart: "catch-all", displayName: `Catch-all ${domain.hostname}` });
		const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
		catchAll = row;
		created = true;
	}
	// A different catch-all already owns the domain: never shadow it silently.
	const [otherRule] = await db
		.select({ id: routingRules.id, mailboxId: routingRules.mailboxId })
		.from(routingRules)
		.where(and(eq(routingRules.domainId, domainId), eq(routingRules.scope, "domain"), eq(routingRules.action, "store"), eq(routingRules.pattern, "*")))
		.limit(1);
	if (otherRule && otherRule.mailboxId !== catchAll.id) throw new Error("This domain already has a catch-all rule pointing at another mailbox");
	if (!otherRule) {
		await db.insert(routingRules).values({
			id: newId("rrule"),
			userId: domain.userId,
			domainId,
			scope: "domain",
			name: "Catch-all",
			enabled: true,
			pattern: "*",
			matchField: "email",
			matchOperator: "contains",
			matchValue: "*",
			mailboxId: catchAll.id,
			action: "store",
		});
	}
	return { mailboxId: catchAll.id, address: `catch-all@${domain.hostname}`, created };
}