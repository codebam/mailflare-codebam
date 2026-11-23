import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A sender-domain block must be a real mailbox routing rule: captured in the
// same table Settings → Rules edits, and applied by the inbound router before
// the spam classifier runs.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mcp-domain-blocks-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		mailTools: join(root, "src/lib/mcp/mail-tools.ts"),
		routing: join(root, "src/lib/email/routing.ts"),
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
	plugins: [{
		name: "mcp-mock",
		setup(builder) {
			builder.onResolve({ filter: /^@modelcontextprotocol\/server$/ }, () => ({ path: "mcp", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
				contents: `export class McpServer { constructor() { this.tools = new Map(); } registerTool(name, config, handler) { this.tools.set(name, handler); } }`,
				loader: "js",
			}));
		},
	}],
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { registerMailMcpTools } = await load("mailTools");
const { resolveInboxRuleDestination } = await load("routing");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 'admin', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0);
	`);
	const server = { tools: new Map(), registerTool(name, config, handler) { this.tools.set(name, handler); } };
	const env = { DB: database };
	registerMailMcpTools(server, { keyId: "k1", user: { id: "u1", role: "admin" }, scopes: ["mcp:read", "mcp:organize"], mailboxIds: ["mb1"] }, env);
	const call = async (name, args) => {
		const result = await server.tools.get(name)(args);
		return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
	};
	const route = (fromAddress, toAddress = "kevin@example.com") => resolveInboxRuleDestination(getDb(env), { mailboxId: "mb1", fromAddress, toAddress });
	return { raw: database.db, call, route };
}

test("blocking a sender domain files future mail from it into Spam", async (t) => {
	const { raw, call, route } = await createFixture(t);

	assert.deepEqual((await call("get_sender_domain_blocks", { mailboxId: "mb1" })).data, { blocks: [] });
	const created = await call("set_sender_domain_block", { mailboxId: "mb1", domain: " Canidea.Cloud " });
	assert.equal(created.isError, false, JSON.stringify(created.data));
	assert.equal(created.data.block.domain, "canidea.cloud");
	assert.equal(created.data.block.enabled, true);
	assert.equal(created.data.block.priority, 100);
	const stored = raw.prepare("SELECT name, scope, action, match_field, match_operator, match_value, mailbox_id, user_id, domain_id, priority FROM routing_rules").get();
	assert.deepEqual({ ...stored }, {
		name: "Block canidea.cloud",
		scope: "mailbox",
		action: "spam",
		match_field: "email",
		match_operator: "contains",
		match_value: "canidea.cloud",
		mailbox_id: "mb1",
		user_id: "u1",
		domain_id: "d1",
		priority: 100,
	});

	// The inbound router now files matching mail as Spam before the classifier runs.
	assert.deepEqual(await route("izcetnh@canidea.cloud"), { status: "spam", folderId: null });
	assert.deepEqual(await route("promo@mail.canidea.cloud"), { status: "spam", folderId: null });
	assert.deepEqual(await route("friend@example.net"), { status: "received", folderId: null });

	// Setting the same block again is idempotent.
	const again = await call("set_sender_domain_block", { mailboxId: "mb1", domain: "@canidea.cloud" });
	assert.equal(again.isError, false, JSON.stringify(again.data));
	assert.equal(again.data.block.ruleId, created.data.block.ruleId);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM routing_rules").get().n, 1);
	const listed = await call("get_sender_domain_blocks", { mailboxId: "mb1" });
	assert.equal(listed.data.blocks.length, 1);
	assert.equal(listed.data.blocks[0].domain, "canidea.cloud");
});

test("removing a sender-domain block deletes the rule and restores normal delivery", async (t) => {
	const { raw, call, route } = await createFixture(t);

	await call("set_sender_domain_block", { mailboxId: "mb1", domain: "canidea.cloud" });
	const removed = await call("remove_sender_domain_block", { mailboxId: "mb1", domain: "Canidea.Cloud" });
	assert.equal(removed.isError, false, JSON.stringify(removed.data));
	assert.deepEqual(removed.data, { removed: true });
	assert.equal(raw.prepare("SELECT count(*) AS n FROM routing_rules").get().n, 0);
	assert.deepEqual(await route("izcetnh@canidea.cloud"), { status: "received", folderId: null });

	const missing = await call("remove_sender_domain_block", { mailboxId: "mb1", domain: "canidea.cloud" });
	assert.equal(missing.isError, true);
});

test("a block needs a bare domain", async (t) => {
	const { raw, call } = await createFixture(t);

	for (const domain of ["", "not a domain", "https://canidea.cloud", "*canidea.cloud", "izcetnh@canidea.cloud"]) {
		const blocked = await call("set_sender_domain_block", { mailboxId: "mb1", domain });
		assert.equal(blocked.isError, true, `expected ${JSON.stringify(domain)} to be rejected`);
	}
	assert.equal(raw.prepare("SELECT count(*) AS n FROM routing_rules").get().n, 0);
});
