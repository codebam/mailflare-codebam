import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { ensureCatchAllMailbox } from "@/lib/catch-all/service";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Provisions catch-all@<domain> plus the domain store rule, idempotently:
 * `{ domainId }`. Only the domain owner (or an admin) may enable it.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const body = (await request.json().catch(() => null)) as { domainId?: unknown } | null;
	if (typeof body?.domainId !== "string" || !body.domainId) return NextResponse.json({ error: "domainId is required" }, { status: 400 });
	const db = getDb(env);
	const [domain] = await db.select().from(domains).where(eq(domains.id, body.domainId)).limit(1);
	if (!domain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	if (domain.userId !== user.id && user.role !== "admin") return NextResponse.json({ error: "You cannot manage this domain" }, { status: 403 });
	try {
		const result = await ensureCatchAllMailbox(db, body.domainId);
		return NextResponse.json(result, { status: result.created ? 201 : 200 });
	} catch (error) {
		if (error instanceof Error && /already has a catch-all/.test(error.message)) return NextResponse.json({ error: error.message }, { status: 409 });
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}