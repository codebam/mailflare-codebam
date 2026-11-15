import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-compat-shared-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { shared: join(root, "src/lib/mcp/compat-shared.ts"), chat: join(root, "src/lib/ai/chat.ts") },
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
const shared = await load("shared");
const chat = await load("chat");

test("parseWhen accepts ISO instants and relative shorthands", () => {
	const iso = shared.parseWhen("2027-01-01T00:00:00Z");
	assert.equal(iso.toISOString(), "2027-01-01T00:00:00.000Z");
	const before = Date.now();
	const relative = shared.parseWhen("2h");
	assert.ok(relative.getTime() >= before + 2 * 3_600_000 - 1000);
	assert.ok(relative.getTime() <= Date.now() + 2 * 3_600_000 + 1000);
	assert.ok(shared.parseWhen("30m"));
	assert.ok(shared.parseWhen("3d"));
	assert.ok(shared.parseWhen("1w"));
	assert.equal(shared.parseWhen("tomorrow"), null);
	assert.equal(shared.parseWhen(""), null);
	assert.equal(shared.parseWhen("99x"), null);
});

test("threadKeyOf falls back to the message id", () => {
	assert.equal(shared.threadKeyOf({ id: "m1", threadId: "t1" }), "t1");
	assert.equal(shared.threadKeyOf({ id: "m1", threadId: null }), "m1");
});

test("resolveChatModel: none, Workers AI, OpenAI-compatible", () => {
	assert.equal(chat.resolveChatModel({}), null);
	const workers = chat.resolveChatModel({ AI: { run: async () => ({ response: "ok" }) } });
	assert.ok(workers.model.startsWith("@cf/"));
	const openai = chat.resolveChatModel({ AI_BASE_URL: "https://api.example.com/v1", AI_API_KEY: "k", AI_MODEL: "test-model" });
	assert.equal(openai.model, "test-model");
});