import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { accessTokens, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { formatAppToken, formatMailboxToken, generateTokenSecret, hashToken, normalizeScopes, parseToken, type AccessTokenScope } from "./token-utils";
import type { SessionUser } from "@/lib/auth/types";

/**
 * Scoped automation tokens: issuance, verification and revocation. The
 * plaintext token is returned once at creation; only its SHA-256 hex is
 * stored. Verification is a hash lookup — the row (not the wire segment)
 * is authoritative for the mailbox binding, so migrated tokens work.
 */

export type VerifiedToken = {
	id: string;
	kind: "mailbox" | "app";
	userId: string;
	mailboxId: string | null;
	scopes: AccessTokenScope[];
	user: SessionUser;
};

export async function issueToken(
	db: AppDatabase,
	input: { kind: "mailbox" | "app"; userId: string; mailboxId?: string | null; name: string; scopes: unknown },
): Promise<{ id: string; token: string; kind: "mailbox" | "app"; mailboxId: string | null; name: string; scopes: AccessTokenScope[] }> {
	const scopes = normalizeScopes(input.scopes);
	if (scopes.length === 0) throw new Error("At least one scope (read, draft, send, manage) is required");
	const name = input.name.trim();
	if (!name || name.length > 100) throw new Error("Token name must be 1-100 characters");
	if (input.kind === "mailbox" && !input.mailboxId) throw new Error("A mailbox token needs a mailboxId");
	if (input.kind === "app" && input.mailboxId) throw new Error("An app token cannot name a mailbox");
	const secret = generateTokenSecret();
	const token = input.kind === "mailbox" ? formatMailboxToken(input.mailboxId!, secret) : formatAppToken(secret);
	const id = newId("tok");
	await db.insert(accessTokens).values({
		id,
		tokenHash: await hashToken(token),
		kind: input.kind,
		userId: input.userId,
		mailboxId: input.kind === "mailbox" ? input.mailboxId! : null,
		name,
		scopes: JSON.stringify(scopes),
	});
	return { id, token, kind: input.kind, mailboxId: input.kind === "mailbox" ? input.mailboxId! : null, name, scopes };
}

export async function verifyToken(db: AppDatabase, tokenString: string): Promise<VerifiedToken | null> {
	const parsed = parseToken(tokenString.trim());
	if (!parsed) return null;
	const [row] = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, await hashToken(tokenString.trim()))).limit(1);
	if (!row) return null;
	if (row.kind !== parsed.kind) return null;
	const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
	if (!user || user.disabled) return null;
	if (row.kind === "mailbox") {
		if (!row.mailboxId) return null;
		const access = await getMailboxAccessLevel(db, user, row.mailboxId);
		if (!access?.canRead) return null;
	}
	const stale = new Date(Date.now() - 60_000);
	if (!row.lastUsedAt || row.lastUsedAt < stale) {
		await db.update(accessTokens).set({ lastUsedAt: new Date() }).where(eq(accessTokens.id, row.id));
	}
	return { id: row.id, kind: row.kind, userId: row.userId, mailboxId: row.mailboxId, scopes: normalizeScopes(JSON.parse(row.scopes)), user };
}

/** Token metadata for the settings UI — never the hash or plaintext. */
export async function listTokens(db: AppDatabase, userId: string, mailboxId?: string | null) {
	const conditions = [eq(accessTokens.userId, userId)];
	if (mailboxId) conditions.push(eq(accessTokens.mailboxId, mailboxId));
	const rows = await db.select().from(accessTokens).where(and(...conditions)).orderBy(desc(accessTokens.createdAt));
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		mailboxId: row.mailboxId,
		name: row.name,
		scopes: normalizeScopes(JSON.parse(row.scopes)),
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
	}));
}

export async function revokeToken(db: AppDatabase, userId: string, tokenId: string): Promise<boolean> {
	const [row] = await db.select({ id: accessTokens.id }).from(accessTokens).where(and(eq(accessTokens.id, tokenId), eq(accessTokens.userId, userId))).limit(1);
	if (!row) return false;
	await db.delete(accessTokens).where(eq(accessTokens.id, tokenId));
	return true;
}