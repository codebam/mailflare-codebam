import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mute-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		service: join(root, "src/lib/mute/service.ts"),
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
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u1', 'd1', 'other', 0)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

test("mute and unmute are idempotent and mailbox-scoped", async (t) => {
	const { db, raw } = await createFixture(t);
	assert.equal(await service.isThreadMuted(db, "mb1", "thread-1"), false);
	await service.muteThread(db, "mb1", "thread-1");
	await service.muteThread(db, "mb1", "thread-1");
	assert.equal(await service.isThreadMuted(db, "mb1", "thread-1"), true);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM muted_threads").get().n, 1);
	assert.equal(await service.isThreadMuted(db, "mb2", "thread-1"), false);
	await service.muteThread(db, "mb2", "thread-1");
	await service.unmuteThread(db, "mb1", "thread-1");
	await service.unmuteThread(db, "mb1", "thread-1");
	assert.equal(await service.isThreadMuted(db, "mb1", "thread-1"), false);
	assert.equal(await service.isThreadMuted(db, "mb2", "thread-1"), true);
	assert.deepEqual(await service.listMutedThreadKeys(db, "mb2"), ["thread-1"]);
	assert.deepEqual(await service.listMutedThreadKeys(db, "mb1"), []);
	await service.muteThread(db, "mb1", "");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM muted_threads WHERE mailbox_id = 'mb1'").get().n, 0);
});

test("deleting a mailbox cascades its mutes", async (t) => {
	const { db, raw } = await createFixture(t);
	await service.muteThread(db, "mb1", "thread-1");
	raw.prepare("DELETE FROM mailboxes WHERE id = 'mb1'").run();
	assert.equal(raw.prepare("SELECT count(*) AS n FROM muted_threads").get().n, 0);
});