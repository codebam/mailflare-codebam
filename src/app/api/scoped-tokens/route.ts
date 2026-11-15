import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { issueToken, listTokens, revokeToken } from "@/lib/scoped-tokens/service";

/** List the signed-in user's tokens (optionally one mailbox's): `?mailboxId=`. Never returns hashes or plaintext. */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	return NextResponse.json({ tokens: await listTokens(getDb(env), user.id, mailboxId) });
}

/**
 * Mint a token: `{ kind: "mailbox"|"app", mailboxId?, name, scopes }`.
 * The plaintext token is shown once, in this response. App tokens are
 * admin-only; mailbox tokens need manage access to the mailbox.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { kind?: unknown; mailboxId?: unknown; name?: unknown; scopes?: unknown } | null;
	const kind = body?.kind === "app" ? "app" : body?.kind === "mailbox" ? "mailbox" : null;
	if (!kind) return NextResponse.json({ error: "kind must be mailbox or app" }, { status: 400 });
	const db = getDb(env);
	if (kind === "app" && user.role !== "admin") return NextResponse.json({ error: "Only admins can create app tokens" }, { status: 403 });
	let mailboxId: string | null = null;
	if (kind === "mailbox") {
		if (typeof body?.mailboxId !== "string" || !body.mailboxId) return NextResponse.json({ error: "mailboxId is required" }, { status: 400 });
		const access = await getMailboxAccessLevel(db, user, body.mailboxId);
		if (!access?.canManage) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		const [mailbox] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.id, body.mailboxId)).limit(1);
		if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		mailboxId = body.mailboxId;
	}
	try {
		const issued = await issueToken(db, { kind, userId: user.id, mailboxId, name: typeof body?.name === "string" ? body.name : "", scopes: body?.scopes });
		return NextResponse.json(issued, { status: 201 });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Token creation failed" }, { status: 400 });
	}
}

/** Revoke one of the signed-in user's tokens: `?id=`. */
export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const id = new URL(request.url).searchParams.get("id") ?? "";
	const revoked = await revokeToken(getDb(env), user.id, id);
	return revoked ? NextResponse.json({ revoked: true }) : NextResponse.json({ error: "Token not found" }, { status: 404 });
}