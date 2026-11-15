import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mailbox-templates-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		service: join(root, "src/lib/templates/service.ts"),
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

test("create, list, update, delete with bounds", async (t) => {
	const { db } = await createFixture(t);
	const created = await service.createTemplate(db, "mb1", { name: "Reply", subject: "Re: hello", body: "<p>Hi</p>" });
	assert.ok(created.ok);
	assert.equal(created.template.subject, "Re: hello");
	assert.deepEqual(await service.createTemplate(db, "mb1", { name: "x".repeat(121), body: "b" }), { ok: false, error: "invalid_name" });
	assert.deepEqual(await service.createTemplate(db, "mb1", { name: "  ", body: "b" }), { ok: false, error: "invalid_name" });
	assert.deepEqual(await service.createTemplate(db, "mb1", { name: "S", subject: "x".repeat(501), body: "b" }), { ok: false, error: "invalid_subject" });
	assert.deepEqual(await service.createTemplate(db, "mb1", { name: "B", body: "" }), { ok: false, error: "invalid_body" });
	assert.deepEqual(await service.createTemplate(db, "mb1", { name: "B", body: "x".repeat(100_001) }), { ok: false, error: "invalid_body" });
	const updated = await service.updateTemplate(db, "mb1", created.template.id, { subject: null, body: "<p>Bye</p>" });
	assert.ok(updated.ok);
	assert.equal(updated.template.subject, "");
	assert.equal(updated.template.body, "<p>Bye</p>");
	assert.equal(updated.template.name, "Reply");
	assert.deepEqual(await service.updateTemplate(db, "mb2", created.template.id, { name: "X" }), { ok: false, error: "not_found" });
	assert.deepEqual(await service.deleteTemplate(db, "mb2", created.template.id), { ok: false, error: "not_found" });
	assert.ok((await service.deleteTemplate(db, "mb1", created.template.id)).ok);
	assert.deepEqual(await service.listTemplates(db, "mb1"), []);
});

test("the cap is per mailbox", async (t) => {
	const { db } = await createFixture(t);
	for (let i = 0; i < 200; i += 1) {
		const result = await service.createTemplate(db, "mb1", { name: `t-${i}`, body: "b" });
		assert.ok(result.ok, `t-${i}`);
	}
	assert.deepEqual(await service.createTemplate(db, "mb1", { name: "one-too-many", body: "b" }), { ok: false, error: "limit_reached" });
	assert.ok((await service.createTemplate(db, "mb2", { name: "t-0", body: "b" })).ok);
});