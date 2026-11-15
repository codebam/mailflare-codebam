import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-agent-actions-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		service: join(root, "src/lib/agent-actions/service.ts"),
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
const service = await load("service");
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
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, starred, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@b.c', 'kevin@example.com', 'Hello', 'received', 0, 0, 100)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

test("record, list newest first with total, metadata only", async (t) => {
	const { db } = await createFixture(t);
	const first = await service.recordAction(db, "mb1", { tool: "mark_email_read", messageId: "m1", subject: "Hello", before: { read: false }, after: { read: true }, undoable: true });
	await service.recordAction(db, "mb1", { tool: "move_email", messageId: "m1", subject: "Hello", before: { folderId: null }, after: { folderId: "f9" }, undoable: true });
	const { actions, total } = await service.listActions(db, "mb1");
	assert.equal(total, 2);
	assert.equal(actions.length, 2);
	assert.equal(actions[0].tool, "move_email");
	assert.deepEqual(actions[1].beforeState, { read: false });
	assert.equal(actions[0].undoable, true);
	const limited = await service.listActions(db, "mb1", 1);
	assert.equal(limited.actions.length, 1);
	assert.equal(limited.total, 2);
});

test("undo restores before-state once; refusals are explicit", async (t) => {
	const { db, raw } = await createFixture(t);
	const action = await service.recordAction(db, "mb1", { tool: "star_email", messageId: "m1", before: { read: false, starred: false, folderId: null }, after: { starred: true }, undoable: true });
	raw.prepare("UPDATE messages SET starred = 1, read = 1 WHERE id = 'm1'").run();
	const undone = await service.undoAction(db, "mb1", action.id);
	assert.ok(undone.ok);
	assert.ok(undone.action.undoneAt);
	const row = raw.prepare("SELECT starred, read FROM messages WHERE id = 'm1'").get();
	assert.equal(row.starred, 0);
	assert.equal(row.read, 0);
	assert.deepEqual(await service.undoAction(db, "mb1", action.id), { ok: false, error: "already_undone" });
	assert.deepEqual(await service.undoAction(db, "mb1", "missing"), { ok: false, error: "not_found" });
	const notUndoable = await service.recordAction(db, "mb1", { tool: "delete_email", messageId: "m1" });
	assert.deepEqual(await service.undoAction(db, "mb1", notUndoable.id), { ok: false, error: "not_undoable" });
});

test("undo of a deleted message reports message_gone", async (t) => {
	const { db, raw } = await createFixture(t);
	const action = await service.recordAction(db, "mb1", { tool: "mark_email_read", messageId: "m1", before: { read: false }, after: { read: true }, undoable: true });
	raw.prepare("DELETE FROM messages WHERE id = 'm1'").run();
	assert.deepEqual(await service.undoAction(db, "mb1", action.id), { ok: false, error: "message_gone" });
	const listed = await service.listActions(db, "mb1");
	assert.equal(listed.actions[0].messageId, null); // FK set null keeps the log row
});