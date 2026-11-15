import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-rules-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		engine: join(root, "src/lib/rules/engine.ts"),
		service: join(root, "src/lib/rules/service.ts"),
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
const engine = await load("engine");
const service = await load("service");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const rule = (over = {}) => ({
	id: "r1", name: "Rule", enabled: true, priority: 0,
	match: { mode: "all", conditions: { subject_contains: "invoice" } },
	actions: { mark_read: true }, created_at: "2026-01-01T00:00:00.000Z", ...over,
});
const email = (over = {}) => ({ sender: "billing@vendor.com", recipient: "me@example.com", subject: "Your invoice", body: "Please pay", ...over });

// ---- engine ----

test("match modes, disabled rules and empty conditions", () => {
	assert.ok(engine.matchRule(rule(), email()));
	assert.ok(!engine.matchRule(rule({ enabled: false }), email()));
	assert.ok(!engine.matchRule(rule({ match: { mode: "all", conditions: {} } }), email()));
	const any = rule({ match: { mode: "any", conditions: { subject_contains: "nomatch", from_contains: "vendor" } } });
	assert.ok(engine.matchRule(any, email()));
	const all = rule({ match: { mode: "all", conditions: { subject_contains: "nomatch", from_contains: "vendor" } } });
	assert.ok(!engine.matchRule(all, email()));
});

test("conditions are case-insensitive substrings; to covers cc/bcc/envelope", () => {
	assert.ok(engine.matchRule(rule({ match: { mode: "all", conditions: { from_contains: "VENDOR" } } }), email()));
	assert.ok(engine.matchRule(rule({ match: { mode: "all", conditions: { to_contains: "ME@" } } }), email({ recipient: null, cc: "Me@example.com" })));
	assert.ok(engine.matchRule(rule({ match: { mode: "all", conditions: { to_contains: "me@" } } }), email({ recipient: null, envelope_recipient: "me@example.com" })));
	assert.ok(!engine.matchRule(rule({ match: { mode: "all", conditions: { body_contains: "absent" } } }), email()));
	assert.ok(engine.matchRule(rule({ match: { mode: "all", conditions: { has_attachment: true } } }), email({ has_attachment: true })));
	assert.ok(!engine.matchRule(rule({ match: { mode: "all", conditions: { has_attachment: true } } }), email({ has_attachment: false })));
	assert.ok(engine.matchRule(rule({ match: { mode: "all", conditions: { category_equals: "FINANCE" } } }), email({ category: "finance" })));
});

test("runRules: priority order, first-write-wins, discard stops, outbound dedup", () => {
	const rules = [
		rule({ id: "late", name: "Late", priority: 5, actions: { mark_read: false, star: true, forward_to: "a@b.com", auto_reply_text: "second" } }),
		rule({ id: "early", name: "Early", priority: 1, actions: { mark_read: true, forward_to: "A@b.com", auto_reply_text: "first" } }),
		rule({ id: "drop", name: "Drop", priority: 9, actions: { discard: true } }),
	];
	const result = engine.runRules(rules, email());
	assert.deepEqual(result.appliedRuleIds, ["early", "late", "drop"]);
	assert.equal(result.mutation.read, true); // first write wins
	assert.equal(result.mutation.starred, true);
	assert.ok(result.discarded);
	assert.equal(result.outbound.filter((action) => action.kind === "forward").length, 1); // dedup case-insensitive
	assert.equal(result.outbound.find((action) => action.kind === "auto_reply").text, "first");
});

test("normalizers bound values; outbound helpers strip and forbid", () => {
	const conditions = engine.normalizeRuleConditions({ from_contains: "  x  ", subject_contains: "y".repeat(600), has_attachment: "yes" });
	assert.equal(conditions.from_contains, "x");
	assert.equal(conditions.subject_contains.length, 500);
	assert.equal(conditions.has_attachment, undefined);
	const actions = engine.normalizeRuleActions({ forward_to: "a@b.com", auto_reply_text: "hi", discard: true });
	assert.ok(engine.hasOutboundActions(actions));
	assert.deepEqual(engine.stripOutboundActions(actions), { discard: true });
	assert.throws(() => engine.forbidOutboundActions(actions), /operator-only/);
	assert.ok(engine.isRuleEmailAddress("a@b.com"));
	assert.ok(!engine.isRuleEmailAddress("A <a@b.com>"));
	assert.ok(!engine.isRuleEmailAddress("a@b.com, c@d.com"));
	const local = engine.localRuleActions({ move_to_folder: "f", set_category: "c", mark_unread: true, unstar: true, discard: true, forward_to: "a@b.com" });
	assert.deepEqual(local, { folder: "f", category: "c", read: false, starred: false });
	assert.ok(engine.ruleNeedsChange({ folder_id: null, read: true, starred: true }, local));
	assert.ok(!engine.ruleNeedsChange({ folder_id: "f", category: "C", read: false, starred: false }, local));
});

// ---- service ----

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = ON");
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u1', 'd1', 'other', 0)").run();
	database.db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f1', 'u1', 'mb1', 'Receipts', 0)").run();
	const insertMessage = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'u1', ?, 'inbound', ?, 'kevin@example.com', ?, ?, 'received', ?)");
	insertMessage.run("m1", "mb1", "billing@vendor.com", "Your invoice", "pay up", 100);
	insertMessage.run("m2", "mb1", "news@vendor.com", "Weekly newsletter", "read me", 200);
	insertMessage.run("m3", "mb1", "billing@vendor.com", "Second invoice", "pay again", 300);
	insertMessage.run("m4", "mb2", "billing@vendor.com", "Other mailbox invoice", "elsewhere", 400);
	database.db.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('att1', 'm2', 'a.pdf', 'application/pdf', 10, 'k1', 0)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

const draft = (over = {}) => ({ name: "Invoices", match: { mode: "all", conditions: { subject_contains: "invoice" } }, actions: { mark_read: true }, ...over });

test("create validates and resolves folders; agent paths cannot send", async (t) => {
	const { db } = await createFixture(t);
	const created = await service.createRule(db, "mb1", draft({ actions: { move_to_folder: "receipts" } }));
	assert.equal(created.actions.move_to_folder, "f1");
	assert.equal(created.enabled, true);
	await assert.rejects(service.createRule(db, "mb1", draft({ name: "  " })), /name/);
	await assert.rejects(service.createRule(db, "mb1", draft({ match: { mode: "all", conditions: {} } })), /condition/);
	await assert.rejects(service.createRule(db, "mb1", draft({ actions: {} })), /action/);
	await assert.rejects(service.createRule(db, "mb1", draft({ actions: { move_to_folder: "missing" } })), /Unknown folder/);
	await assert.rejects(service.createRule(db, "mb1", draft({ actions: { forward_to: "a@b.com" } }), { agent: true }), /operator-only/);
	await assert.rejects(service.createRule(db, "mb1", draft({ actions: { auto_reply_text: "hi" } }), { agent: true }), /operator-only/);
	const operator = await service.createRule(db, "mb1", draft({ name: "Forward", actions: { forward_to: "a@b.com" } }));
	assert.equal(operator.actions.forward_to, "a@b.com");
	await assert.rejects(service.createRule(db, "mb1", draft({ name: "Bad forward", actions: { forward_to: "not-an-address" } })), /single email address/);
});

test("priority appends by default; update merges; delete is scoped", async (t) => {
	const { db } = await createFixture(t);
	const a = await service.createRule(db, "mb1", draft({ name: "A" }));
	const b = await service.createRule(db, "mb1", draft({ name: "B" }));
	assert.equal(a.priority, 0);
	assert.equal(b.priority, 1);
	const updated = await service.updateRule(db, "mb1", a.id, { name: "A2", enabled: false });
	assert.equal(updated.name, "A2");
	assert.equal(updated.enabled, false);
	assert.deepEqual(updated.match, a.match);
	await assert.rejects(service.updateRule(db, "mb2", a.id, { name: "X" }), /not found/i);
	assert.equal(await service.deleteRule(db, "mb2", a.id), false);
	assert.equal(await service.deleteRule(db, "mb1", a.id), true);
	assert.equal((await service.listRules(db, "mb1")).length, 1);
});

test("reorder puts listed ids first and keeps the rest in order", async (t) => {
	const { db } = await createFixture(t);
	const a = await service.createRule(db, "mb1", draft({ name: "A" }));
	const b = await service.createRule(db, "mb1", draft({ name: "B" }));
	const c = await service.createRule(db, "mb1", draft({ name: "C" }));
	const ordered = await service.reorderRules(db, "mb1", [c.id, "unknown", a.id, c.id]);
	assert.deepEqual(ordered.map((r) => r.name), ["C", "A", "B"]);
	assert.deepEqual(ordered.map((r) => r.priority), [0, 1, 2]);
});

test("preview matches stored mail without writing", async (t) => {
	const { db, raw } = await createFixture(t);
	const preview = await service.previewRule(db, "mb1", { match: { mode: "all", conditions: { subject_contains: "invoice" } } });
	assert.equal(preview.total, 2); // m1 + m3, not m4 (other mailbox)
	assert.equal(preview.scanned, 3);
	assert.deepEqual(preview.matches.map((m) => m.id).sort(), ["m1", "m3"]);
	assert.equal(raw.prepare("SELECT read FROM messages WHERE id = 'm1'").get().read, 0);
	const attachmentPreview = await service.previewRule(db, "mb1", { match: { mode: "all", conditions: { has_attachment: true } } });
	assert.deepEqual(attachmentPreview.matches.map((m) => m.id), ["m2"]);
});

test("apply is idempotent, batched, and never touches outbound-only rules", async (t) => {
	const { db, raw } = await createFixture(t);
	const created = await service.createRule(db, "mb1", draft({ actions: { move_to_folder: "f1", star: true } }));
	const first = await service.applyRule(db, "mb1", created.id, 1);
	assert.equal(first.matched, 2);
	assert.equal(first.applied, 1);
	assert.equal(first.remaining, 1);
	const second = await service.applyRule(db, "mb1", created.id);
	assert.equal(second.applied, 1);
	assert.equal(second.remaining, 0);
	const third = await service.applyRule(db, "mb1", created.id);
	assert.equal(third.applied, 0);
	assert.equal(third.skipped, 2);
	assert.equal(raw.prepare("SELECT folder_id FROM messages WHERE id = 'm1'").get().folder_id, "f1");
	assert.equal(raw.prepare("SELECT starred FROM messages WHERE id = 'm3'").get().starred, 1);
	assert.equal(raw.prepare("SELECT folder_id FROM messages WHERE id = 'm4'").get().folder_id, null);
	const outboundOnly = await service.createRule(db, "mb1", draft({ name: "Forward only", actions: { forward_to: "a@b.com" } }));
	await assert.rejects(service.applyRule(db, "mb1", outboundOnly.id), /no actions/);
	assert.equal(raw.prepare("SELECT fired_count FROM rules WHERE id = ?").get(created.id).fired_count, 0);
});

test("firings are recorded for inbound runs only", async (t) => {
	const { db } = await createFixture(t);
	const created = await service.createRule(db, "mb1", draft());
	const result = await service.runInboundRules(db, "mb1", { sender: "billing@vendor.com", recipient: "kevin@example.com", subject: "Your invoice", body: "pay" });
	assert.ok(result.routed);
	assert.deepEqual(result.appliedRuleIds, [created.id]);
	assert.equal(result.mutation.read, true);
	const [listed] = await service.listRules(db, "mb1");
	assert.equal(listed.fired_count, 1);
	assert.ok(listed.last_fired_at);
});