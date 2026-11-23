import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mcp-spam-feedback-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// The real move_email handler runs against a recording MCP server and a
// migrated SQLite database, exactly as shipped.
await build({
	entryPoints: {
		actions: join(root, "src/lib/mcp/compat-actions.ts"),
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
const { registerCompatActionTools } = await load("actions");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, starred, created_at)
		VALUES ('m1', 'u1', 'mb1', 'inbound', 'promo@junk-campaign.example', 'kevin@example.com', 'Mold could be hiding in your home',
			'You cannot always see mold before it starts spreading. Protect your home before it is too late. Order now.', 'received', 0, 0, 100);
	`);
	const server = { tools: new Map(), registerTool(name, config, handler) { this.tools.set(name, handler); } };
	const env = { DB: database, BUCKET: { delete: async () => {} } };
	registerCompatActionTools(server, { keyId: "k1", user: { id: "u1", role: "user" }, scopes: ["mcp:organize"], mailboxIds: ["mb1"] }, env);
	const call = async (name, args) => {
		const result = await server.tools.get(name)(args);
		return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
	};
	return { raw: database.db, call };
}

test("filing mail into spam through the MCP teaches the spam filter", async (t) => {
	const { raw, call } = await createFixture(t);

	const filed = await call("move_email", { mailboxId: "mb1", emailId: "m1", folderId: "spam" });
	assert.equal(filed.isError, false, JSON.stringify(filed.data));
	assert.deepEqual(filed.data, { emailId: "m1", folderId: "spam" });
	assert.equal(raw.prepare("SELECT status FROM messages WHERE id = 'm1'").get().status, "spam");

	// The same feedback the web UI and the in-app assistant record: a training
	// example plus sender/domain/fingerprint reputation.
	const feedback = raw.prepare("SELECT actor_user_id, classification FROM spam_feedback WHERE message_id = 'm1'").get();
	assert.deepEqual({ ...feedback }, { actor_user_id: "u1", classification: "spam" });
	assert.ok(raw.prepare("SELECT count(*) AS n FROM spam_token_stats").get().n > 0);
	const reputation = raw.prepare("SELECT type, spam_count, ham_count FROM spam_reputation ORDER BY type").all();
	assert.deepEqual(reputation.map((row) => row.type).sort(), ["domain", "email", "fingerprint"]);
	assert.ok(reputation.every((row) => row.spam_count === 1 && row.ham_count === 0), JSON.stringify(reputation));

	// Moving it back out of Spam is ham feedback, which reverses the counts.
	const restored = await call("move_email", { mailboxId: "mb1", emailId: "m1", folderId: "inbox" });
	assert.equal(restored.isError, false, JSON.stringify(restored.data));
	assert.equal(raw.prepare("SELECT status FROM messages WHERE id = 'm1'").get().status, "received");
	assert.equal(raw.prepare("SELECT classification FROM spam_feedback WHERE message_id = 'm1'").get().classification, "ham");
	const emailReputation = raw.prepare("SELECT spam_count, ham_count FROM spam_reputation WHERE type = 'email'").get();
	assert.deepEqual({ ...emailReputation }, { spam_count: 0, ham_count: 1 });
});

test("an ordinary folder move does not record spam feedback", async (t) => {
	const { raw, call } = await createFixture(t);

	const trashed = await call("move_email", { mailboxId: "mb1", emailId: "m1", folderId: "trash" });
	assert.equal(trashed.isError, false, JSON.stringify(trashed.data));
	assert.equal(raw.prepare("SELECT status FROM messages WHERE id = 'm1'").get().status, "trash");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM spam_feedback").get().n, 0);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM spam_reputation").get().n, 0);

	const inbox = await call("move_email", { mailboxId: "mb1", emailId: "m1", folderId: "inbox" });
	assert.equal(inbox.isError, false, JSON.stringify(inbox.data));
	assert.equal(raw.prepare("SELECT status FROM messages WHERE id = 'm1'").get().status, "received");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM spam_feedback").get().n, 0);
});
