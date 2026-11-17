import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-agent-provider-model-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		provider: join(root, "src/lib/agent/provider.ts"),
		constants: join(root, "src/lib/agent/provider-constants.ts"),
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
const { getAgentProviderConfig } = await load("provider");
const { DEFAULT_CLOUDFLARE_MODEL } = await load("constants");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const AI = { run: async () => ({ response: "" }) };

async function fixture(t, saved) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	if (saved) database.db.prepare("UPDATE app_settings SET agent_provider = ?, agent_model = ? WHERE id = 'default'").run(saved.provider, saved.model);
	return { DB: database };
}

test("Workers AI environment config prefers AI_CHAT_MODEL over AI_MODEL", async (t) => {
	const env = { ...(await fixture(t)), AI, AI_CHAT_MODEL: "@cf/openai/gpt-oss-120b", AI_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8" };
	const config = await getAgentProviderConfig(env);
	assert.equal(config.model, "@cf/openai/gpt-oss-120b");
	assert.deepEqual(config.models, ["@cf/openai/gpt-oss-120b"]);
	assert.equal(config.source, "environment");
});

test("AI_MODEL still applies when AI_CHAT_MODEL is unset", async (t) => {
	const env = { ...(await fixture(t)), AI, AI_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8" };
	const config = await getAgentProviderConfig(env);
	assert.equal(config.model, "@cf/qwen/qwen3-30b-a3b-fp8");
});

test("without model vars the Workers AI default is unchanged", async (t) => {
	const config = await getAgentProviderConfig({ ...(await fixture(t)), AI });
	assert.equal(config.model, DEFAULT_CLOUDFLARE_MODEL);
});

test("a saved provider model wins over AI_CHAT_MODEL", async (t) => {
	const env = { ...(await fixture(t, { provider: "cloudflare", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })), AI, AI_CHAT_MODEL: "@cf/openai/gpt-oss-120b" };
	const config = await getAgentProviderConfig(env);
	assert.equal(config.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
	assert.equal(config.source, "saved");
});

test("a saved cloudflare provider without a model honours AI_CHAT_MODEL", async (t) => {
	const env = { ...(await fixture(t, { provider: "cloudflare", model: null })), AI, AI_CHAT_MODEL: "@cf/openai/gpt-oss-120b" };
	const config = await getAgentProviderConfig(env);
	assert.equal(config.model, "@cf/openai/gpt-oss-120b");
	assert.equal(config.source, "saved");
});

test("OpenAI-compatible endpoints keep AI_MODEL, not AI_CHAT_MODEL", async (t) => {
	const base = { ...(await fixture(t)), AI_BASE_URL: "https://api.openai.com/v1", AI_API_KEY: "k", AI_CHAT_MODEL: "@cf/openai/gpt-oss-120b" };
	assert.equal((await getAgentProviderConfig({ ...base, AI_MODEL: "gpt-5" })).model, "gpt-5");
	assert.equal((await getAgentProviderConfig(base)).model, "gpt-4o-mini");
});
