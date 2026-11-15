import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-saved-searches-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		service: join(root, "src/lib/saved-searches/service.ts"),
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
	return { db: getDb({ DB: database }) };
}

test("create, list newest first, update, delete; names may repeat", async (t) => {
	const { db } = await createFixture(t);
	const first = await service.createSavedSearch(db, "mb1", { name: "Invoices", query: "subject:invoice" });
	assert.ok(first.ok);
	const second = await service.createSavedSearch(db, "mb1", { name: "Invoices", query: "from:billing" });
	assert.ok(second.ok);
	const listed = await service.listSavedSearches(db, "mb1");
	assert.equal(listed.length, 2);
	assert.deepEqual(await service.createSavedSearch(db, "mb1", { name: "x".repeat(121), query: "q" }), { ok: false, error: "invalid_name" });
	assert.deepEqual(await service.createSavedSearch(db, "mb1", { name: "Q", query: " " }), { ok: false, error: "invalid_query" });
	assert.deepEqual(await service.createSavedSearch(db, "mb1", { name: "Q", query: "x".repeat(1001) }), { ok: false, error: "invalid_query" });
	const updated = await service.updateSavedSearch(db, "mb1", first.search.id, { query: "subject:receipt" });
	assert.ok(updated.ok);
	assert.equal(updated.search.query, "subject:receipt");
	assert.equal(updated.search.name, "Invoices");
	assert.deepEqual(await service.updateSavedSearch(db, "mb2", first.search.id, { name: "X" }), { ok: false, error: "not_found" });
	assert.ok((await service.deleteSavedSearch(db, "mb1", first.search.id)).ok);
	assert.deepEqual(await service.deleteSavedSearch(db, "mb1", first.search.id), { ok: false, error: "not_found" });
	assert.equal((await service.listSavedSearches(db, "mb1")).length, 1);
});

test("the cap is per mailbox", async (t) => {
	const { db } = await createFixture(t);
	for (let i = 0; i < 50; i += 1) {
		const result = await service.createSavedSearch(db, "mb1", { name: `s-${i}`, query: "q" });
		assert.ok(result.ok, `s-${i}`);
	}
	assert.deepEqual(await service.createSavedSearch(db, "mb1", { name: "one-too-many", query: "q" }), { ok: false, error: "limit_reached" });
	assert.ok((await service.createSavedSearch(db, "mb2", { name: "s-0", query: "q" })).ok);
});