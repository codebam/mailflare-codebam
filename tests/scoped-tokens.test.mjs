import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-scoped-tokens-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		utils: join(root, "src/lib/scoped-tokens/token-utils.ts"),
		service: join(root, "src/lib/scoped-tokens/service.ts"),
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
const utils = await load("utils");
const service = await load("service");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

test("wire format round-trips and the parsers are disjoint", () => {
	const secret = utils.generateTokenSecret();
	assert.equal(secret.length, 43);
	const mailboxToken = utils.formatMailboxToken("mbx_Test-123", secret);
	assert.ok(mailboxToken.startsWith("ain1_"));
	const parsed = utils.parseToken(mailboxToken);
	assert.deepEqual(parsed, { kind: "mailbox", mailboxId: "mbx_Test-123", secret });
	const appToken = utils.formatAppToken(secret);
	assert.deepEqual(utils.parseToken(appToken), { kind: "app", secret });
	// Disjoint: an app token never parses as mailbox and vice versa.
	assert.equal(utils.parseToken(appToken)?.kind, "app");
	assert.equal(utils.parseToken(mailboxToken)?.kind, "mailbox");
	assert.equal(utils.parseToken("ain1_nothex_zz"), null);
	assert.equal(utils.parseToken("ain2_short"), null);
	assert.equal(utils.parseToken("ep_something"), null);
	assert.equal(utils.parseToken(""), null);
	// Hex segment survives unicode mailbox ids.
	const unicode = utils.formatMailboxToken("mail@exämple.com", secret);
	assert.equal(utils.parseToken(unicode).mailboxId, "mail@exämple.com");
});

test("hashToken is the SHA-256 hex of the full string", async () => {
	const hash = await utils.hashToken("ain2_abc");
	assert.match(hash, /^[0-9a-f]{64}$/);
	assert.equal(hash, await utils.hashToken("ain2_abc"));
	assert.notEqual(hash, await utils.hashToken("ain2_abd"));
});

test("normalizeScopes dedups and filters", () => {
	assert.deepEqual(utils.normalizeScopes(["read", "read", "send", "bogus", 3]), ["read", "send"]);
	assert.deepEqual(utils.normalizeScopes("read"), []);
	assert.deepEqual(utils.normalizeScopes(undefined), []);
});

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = ON");
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

test("issue, verify, list and revoke tokens", async (t) => {
	const { db } = await createFixture(t);
	const issued = await service.issueToken(db, { kind: "mailbox", userId: "u1", mailboxId: "mb1", name: "Phone", scopes: ["read", "manage"] });
	assert.ok(issued.token.startsWith("ain1_"));
	assert.deepEqual(issued.scopes, ["read", "manage"]);
	const verified = await service.verifyToken(db, issued.token);
	assert.ok(verified);
	assert.equal(verified.kind, "mailbox");
	assert.equal(verified.mailboxId, "mb1");
	assert.equal(verified.user.id, "u1");
	assert.equal(await service.verifyToken(db, "ain1_00_".padEnd(60, "a")), null);
	const app = await service.issueToken(db, { kind: "app", userId: "u1", name: "Automation", scopes: ["read"] });
	assert.ok(app.token.startsWith("ain2_"));
	assert.equal((await service.verifyToken(db, app.token)).kind, "app");
	const listed = await service.listTokens(db, "u1");
	assert.equal(listed.length, 2);
	assert.ok(!JSON.stringify(listed).includes(issued.token));
	assert.ok((await service.revokeToken(db, "u1", issued.id)));
	assert.equal(await service.verifyToken(db, issued.token), null);
	assert.equal(await service.revokeToken(db, "u1", issued.id), false);
	await assert.rejects(service.issueToken(db, { kind: "mailbox", userId: "u1", mailboxId: "mb1", name: "X", scopes: [] }), /scope/);
	await assert.rejects(service.issueToken(db, { kind: "app", userId: "u1", mailboxId: "mb1", name: "X", scopes: ["read"] }), /cannot name a mailbox/);
});

test("a disabled user's token stops verifying", async (t) => {
	const { db, raw } = await createFixture(t);
	const issued = await service.issueToken(db, { kind: "mailbox", userId: "u1", mailboxId: "mb1", name: "Phone", scopes: ["read"] });
	assert.ok(await service.verifyToken(db, issued.token));
	raw.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.equal(await service.verifyToken(db, issued.token), null);
});