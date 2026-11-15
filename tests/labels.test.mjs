import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-labels-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		service: join(root, "src/lib/labels/service.ts"),
		utils: join(root, "src/lib/labels/label-utils.ts"),
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
const utils = await load("utils");
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
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@b.c', 'kevin@example.com', 0)").run();
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, created_at) VALUES ('m2', 'u1', 'mb2', 'inbound', 'a@b.c', 'other@example.com', 0)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

test("name helpers normalize, key and validate colors", () => {
	assert.equal(utils.normalizeLabelName("  Receipts   2026 \t"), "Receipts 2026");
	assert.equal(utils.labelNameKey("  Receipts "), "receipts");
	assert.equal(utils.normalizeLabelName("   "), "");
	assert.ok(utils.isValidLabelColor("#f59e0b"));
	assert.ok(utils.isValidLabelColor("#ABC"));
	assert.ok(!utils.isValidLabelColor("f59e0b"));
	assert.ok(!utils.isValidLabelColor("#12345"));
	assert.ok(!utils.isValidLabelColor("red"));
});

test("create, list ordered by name, and resolve by name or id", async (t) => {
	const { db } = await createFixture(t);
	const beta = await service.createLabel(db, "mb1", { name: "beta", color: "#f59e0b" });
	assert.ok(beta.ok);
	const alpha = await service.createLabel(db, "mb1", { name: "Alpha" });
	assert.ok(alpha.ok);
	const labels = await service.listLabels(db, "mb1");
	assert.deepEqual(labels.map((label) => label.name), ["Alpha", "beta"]);
	assert.equal(labels[1].color, "#f59e0b");
	assert.equal(labels[0].color, null);
	assert.deepEqual(await service.resolveLabel(db, "mb1", "BETA"), beta.label);
	assert.deepEqual(await service.resolveLabel(db, "mb1", beta.label.id), beta.label);
	assert.equal(await service.resolveLabel(db, "mb1", "missing"), null);
});

test("names are unique case-insensitively and capped at 50 characters", async (t) => {
	const { db } = await createFixture(t);
	assert.ok((await service.createLabel(db, "mb1", { name: "Receipts" })).ok);
	assert.deepEqual(await service.createLabel(db, "mb1", { name: "receipts" }), { ok: false, error: "name_taken" });
	assert.deepEqual(await service.createLabel(db, "mb1", { name: "  RECEIPTS  " }), { ok: false, error: "name_taken" });
	assert.deepEqual(await service.createLabel(db, "mb1", { name: "x".repeat(51) }), { ok: false, error: "invalid_name" });
	assert.deepEqual(await service.createLabel(db, "mb1", { name: "   " }), { ok: false, error: "invalid_name" });
	assert.deepEqual(await service.createLabel(db, "mb1", { name: "Bad", color: "red" }), { ok: false, error: "invalid_color" });
});

test("a mailbox holds at most 100 labels", async (t) => {
	const { db } = await createFixture(t);
	for (let i = 0; i < 100; i += 1) {
		const result = await service.createLabel(db, "mb1", { name: `label-${i}` });
		assert.ok(result.ok, `label-${i}`);
	}
	assert.deepEqual(await service.createLabel(db, "mb1", { name: "one-too-many" }), { ok: false, error: "limit_reached" });
	// The cap is per mailbox.
	assert.ok((await service.createLabel(db, "mb2", { name: "label-0" })).ok);
});

test("update renames, recolors and clears color; collisions are refused", async (t) => {
	const { db } = await createFixture(t);
	const a = await service.createLabel(db, "mb1", { name: "A", color: "#111111" });
	const b = await service.createLabel(db, "mb1", { name: "B" });
	assert.ok(a.ok && b.ok);
	const renamed = await service.updateLabel(db, "mb1", a.label.id, { name: "A2", color: "#222222" });
	assert.ok(renamed.ok);
	assert.equal(renamed.label.name, "A2");
	assert.equal(renamed.label.color, "#222222");
	assert.deepEqual(await service.updateLabel(db, "mb1", a.label.id, { name: "b" }), { ok: false, error: "name_taken" });
	const cleared = await service.updateLabel(db, "mb1", a.label.id, { color: null });
	assert.ok(cleared.ok);
	assert.equal(cleared.label.color, null);
	assert.equal(cleared.label.name, "A2");
	// Same name with different casing is not a collision with itself.
	assert.ok((await service.updateLabel(db, "mb1", a.label.id, { name: "a2" })).ok);
	assert.deepEqual(await service.updateLabel(db, "mb1", "missing", { name: "X" }), { ok: false, error: "not_found" });
});

test("attach and detach are idempotent and answer the message's labels", async (t) => {
	const { db } = await createFixture(t);
	const label = await service.createLabel(db, "mb1", { name: "Work" });
	assert.ok(label.ok);
	const added = await service.addMessageLabel(db, "mb1", "m1", label.label.id);
	assert.ok(added.ok);
	assert.deepEqual(added.labels.map((l) => l.name), ["Work"]);
	const again = await service.addMessageLabel(db, "mb1", "m1", label.label.id);
	assert.ok(again.ok);
	assert.equal(again.labels.length, 1);
	const removed = await service.removeMessageLabel(db, "mb1", "m1", label.label.id);
	assert.ok(removed.ok);
	assert.deepEqual(removed.labels, []);
	const noop = await service.removeMessageLabel(db, "mb1", "m1", label.label.id);
	assert.ok(noop.ok);
	assert.deepEqual(noop.labels, []);
});

test("labels cannot cross mailboxes", async (t) => {
	const { db } = await createFixture(t);
	const label = await service.createLabel(db, "mb1", { name: "Work" });
	assert.ok(label.ok);
	assert.deepEqual(await service.addMessageLabel(db, "mb2", "m2", label.label.id), { ok: false, error: "not_found" });
	assert.deepEqual(await service.addMessageLabel(db, "mb1", "m2", label.label.id), { ok: false, error: "not_found" });
	assert.deepEqual(await service.removeMessageLabel(db, "mb2", "m1", label.label.id), { ok: false, error: "not_found" });
	assert.deepEqual(await service.updateLabel(db, "mb2", label.label.id, { name: "X" }), { ok: false, error: "not_found" });
	assert.deepEqual(await service.deleteLabel(db, "mb2", label.label.id), { ok: false, error: "not_found" });
	assert.equal((await service.listLabels(db, "mb2")).length, 0);
});

test("deleting a label detaches it; deleting a message cascades its joins", async (t) => {
	const { db, raw } = await createFixture(t);
	const label = await service.createLabel(db, "mb1", { name: "Work" });
	assert.ok(label.ok);
	assert.ok((await service.addMessageLabel(db, "mb1", "m1", label.label.id)).ok);
	assert.ok((await service.deleteLabel(db, "mb1", label.label.id)).ok);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM message_labels").get().n, 0);
	assert.deepEqual(await service.listLabels(db, "mb1"), []);
	const other = await service.createLabel(db, "mb1", { name: "Other" });
	assert.ok(other.ok);
	assert.ok((await service.addMessageLabel(db, "mb1", "m1", other.label.id)).ok);
	raw.prepare("DELETE FROM messages WHERE id = 'm1'").run();
	assert.equal(raw.prepare("SELECT count(*) AS n FROM message_labels").get().n, 0);
	assert.equal((await service.listLabels(db, "mb1")).length, 1);
});

test("labelsForMessages batches list-row lookups", async (t) => {
	const { db } = await createFixture(t);
	const work = await service.createLabel(db, "mb1", { name: "Work" });
	const personal = await service.createLabel(db, "mb1", { name: "Personal" });
	assert.ok(work.ok && personal.ok);
	assert.ok((await service.addMessageLabel(db, "mb1", "m1", work.label.id)).ok);
	assert.ok((await service.addMessageLabel(db, "mb1", "m1", personal.label.id)).ok);
	const map = await service.labelsForMessages(db, ["m1", "m2", "missing"]);
	assert.deepEqual(map.get("m1").map((l) => l.name), ["Personal", "Work"]);
	assert.equal(map.has("m2"), false);
	assert.equal(map.has("missing"), false);
	assert.equal((await service.labelsForMessages(db, [])).size, 0);
});