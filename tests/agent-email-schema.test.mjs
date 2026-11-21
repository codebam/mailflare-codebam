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

test("accepts a single well-formed email address", () => {
	for (const value of ["alice@example.com", "first.last+tag@sub.example.co.uk"]) {
		assert.equal(toolEmailSchema.safeParse(value).success, true, value);
	}
});

test("rejects malformed and multi-address input with the custom message", () => {
	for (const value of ["", "not-an-email", "a..b@example.com", "alice@", "a@b.com, c@d.com"]) {
		const result = toolEmailSchema.safeParse(value);
		assert.equal(result.success, false, value);
		assert.equal(result.error.issues[0].message, "Invalid email", value);
	}
});

test("rejects non-string values before the email refinement", () => {
	const result = toolEmailSchema.safeParse(123);
	assert.equal(result.success, false);
	assert.match(result.error.issues[0].message, /expected string/);
});

test("advertises the email format and a model-facing description in its metadata", () => {
	assert.deepEqual(toolEmailSchema.meta(), {
		format: "email",
		description: "A single email address",
	});
});
