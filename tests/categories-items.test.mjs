import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-categories-items-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		categories: join(root, "src/lib/categories/service.ts"),
		items: join(root, "src/lib/items/service.ts"),
		itemUtils: join(root, "src/lib/items/item-utils.ts"),
		digest: join(root, "src/lib/digest/service.ts"),
		db: join(root, "src/db/index.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const categories = await load("categories");
const items = await load("items");
const itemUtils = await load("itemUtils");
const digest = await load("digest");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = ON");
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u1', 'd1', 'other', 0)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

test("categories: mailbox + global scopes, case-insensitive uniqueness", async (t) => {
	const { db } = await createFixture(t);
	const global = await categories.createCategory(db, "", { name: "Receipts" });
	assert.ok(global.ok);
	assert.equal(global.category.global, true);
	const local = await categories.createCategory(db, "mb1", { name: "Work", color: "#f59e0b" });
	assert.ok(local.ok);
	assert.deepEqual(await categories.createCategory(db, "mb1", { name: "work" }), { ok: false, error: "name_taken" });
	assert.ok((await categories.createCategory(db, "mb2", { name: "Work" })).ok); // per-mailbox scope
	const listed = await categories.listCategories(db, "mb1");
	assert.deepEqual(listed.map((category) => category.name).sort(), ["Receipts", "Work"]);
	assert.equal((await categories.listCategories(db, "mb2")).length, 2);
	const renamed = await categories.updateCategory(db, "mb1", local.category.id, { name: "Projects", color: null });
	assert.ok(renamed.ok);
	assert.equal(renamed.category.name, "Projects");
	assert.equal(renamed.category.color, null);
	assert.deepEqual(await categories.updateCategory(db, "mb2", local.category.id, { name: "X" }), { ok: false, error: "not_found" });
	assert.ok((await categories.deleteCategory(db, "mb1", local.category.id)).ok);
	assert.equal((await categories.listCategories(db, "mb1")).length, 1);
});

test("items: create, filter by status and due bucket, update status", async (t) => {
	const { db } = await createFixture(t);
	const now = new Date("2026-11-15T12:00:00Z");
	const overdue = await items.createItem(db, "mb1", { kind: "deadline", title: "Pay invoice", dueAt: new Date("2026-11-14T12:00:00Z") });
	const today = await items.createItem(db, "mb1", { title: "Reply to Alice", dueAt: new Date("2026-11-15T18:00:00Z") });
	const upcoming = await items.createItem(db, "mb1", { title: "Renew domain", dueAt: new Date("2026-12-01T00:00:00Z") });
	const noDue = await items.createItem(db, "mb1", { title: "Read backlog" });
	assert.ok(overdue.ok && today.ok && upcoming.ok && noDue.ok);
	assert.equal((await items.listItems(db, "mb1", {}, now)).length, 4);
	assert.deepEqual((await items.listItems(db, "mb1", { due: "overdue" }, now)).map((item) => item.title), ["Pay invoice"]);
	assert.deepEqual((await items.listItems(db, "mb1", { due: "today" }, now)).map((item) => item.title), ["Reply to Alice"]);
	assert.deepEqual((await items.listItems(db, "mb1", { due: "upcoming" }, now)).map((item) => item.title), ["Renew domain"]);
	assert.deepEqual((await items.listItems(db, "mb1", { due: "none" }, now)).map((item) => item.title), ["Read backlog"]);
	const done = await items.updateItem(db, "mb1", overdue.item.id, { status: "done" });
	assert.ok(done.ok);
	assert.equal(done.item.status, "done");
	assert.equal((await items.listItems(db, "mb1", { status: "open" }, now)).length, 3);
	assert.deepEqual(await items.updateItem(db, "mb1", overdue.item.id, { status: "bogus" }), { ok: false, error: "invalid_status" });
	assert.deepEqual(await items.updateItem(db, "mb2", overdue.item.id, { status: "done" }), { ok: false, error: "not_found" });
	assert.deepEqual(await items.createItem(db, "mb1", { title: "x".repeat(501) }), { ok: false, error: "invalid_title" });
	assert.deepEqual(await items.createItem(db, "mb1", { title: "K", kind: "chore" }), { ok: false, error: "invalid_kind" });
	assert.equal(itemUtils.itemDueBucket(null, now), "none");
});

test("digest summarizes the trailing 24 hours", async (t) => {
	const { db, raw } = await createFixture(t);
	const now = new Date("2026-11-15T12:00:00Z");
	const recent = Math.floor(now.getTime() / 1000) - 3600;
	const old = Math.floor(now.getTime() / 1000) - 48 * 3600;
	raw.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, category, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@b.c', 'k@e.c', 'New', 'received', 0, 'work', ?)").run(recent);
	raw.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES ('m2', 'u1', 'mb1', 'inbound', 'a@b.c', 'k@e.c', 'Old', 'received', 0, ?)").run(old);
	raw.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('m3', 'u1', 'mb1', 'outbound', 'k@e.c', 'a@b.c', 'Sent', 'sent', ?)").run(recent);
	await items.createItem(db, "mb1", { title: "Due soon", dueAt: new Date("2026-11-15T18:00:00Z") });
	const brief = await digest.getDigest(db, "mb1", now);
	assert.equal(brief.arrivals, 1);
	assert.equal(brief.sent, 1);
	// Needs-reply is not period-bound: both unread received messages count.
	assert.equal(brief.needsReply, 2);
	assert.deepEqual(brief.recent.map((row) => row.id), ["m1"]);
	assert.deepEqual(brief.categories, [{ category: "work", count: 1 }]);
	assert.deepEqual(brief.itemsDue.map((item) => item.title), ["Due soon"]);
	assert.equal(brief.remindersDue, 0);
});