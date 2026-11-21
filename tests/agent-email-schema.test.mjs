import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodSchema } from "ai";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-email-schema-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/agent/schema-utils.ts")],
	outfile: join(dir, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { toolEmailSchema } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

test("toolEmailSchema accepts one valid address and rejects malformed or multiple ones", () => {
	assert.equal(toolEmailSchema.safeParse("owner@example.com").success, true);
	assert.equal(toolEmailSchema.safeParse("a+b@sub.example.co.uk").success, true);
	assert.equal(toolEmailSchema.safeParse("").success, false);
	assert.equal(toolEmailSchema.safeParse("not-an-email").success, false);
	assert.equal(toolEmailSchema.safeParse("a..b@example.com").success, false);
	assert.equal(toolEmailSchema.safeParse("a@example.com, b@example.com").success, false);
});

test("toolEmailSchema advertises an email format without a lookaround pattern", () => {
	for (const json of [
		zodSchema(toolEmailSchema).jsonSchema,
		toolEmailSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
	]) {
		assert.equal(json.format, "email");
		assert.match(json.description, /single email address/);
		assert.equal(json.pattern, undefined);
	}
});
