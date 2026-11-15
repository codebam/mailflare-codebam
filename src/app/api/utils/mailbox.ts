import { NextResponse } from "next/server";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export type LoadedMailbox = {
	user: SessionUser;
	db: AppDatabase;
	mailboxId: string;
	canManage: boolean;
};

/** The signed-in user and a mailbox they can read; `needManage` also requires write access. */
export async function loadMailbox(request: Request, mailboxId: unknown, needManage = false): Promise<LoadedMailbox | { error: NextResponse }> {
	if (typeof mailboxId !== "string" || !mailboxId) return { error: NextResponse.json({ error: "mailboxId is required" }, { status: 400 }) };
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return { error: NextResponse.json({ error: "Mailbox not found" }, { status: 404 }) };
	if (needManage && !access.canManage) return { error: NextResponse.json({ error: "You cannot manage this mailbox" }, { status: 403 }) };
	return { user, db, mailboxId, canManage: access.canManage };
}

export const migrationRequired = () =>
	NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });