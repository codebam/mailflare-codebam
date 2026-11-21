import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-schema-utils-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/agent/schema-utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { toolEmailSchema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("accepts a single valid email address", () => {
	for (const value of ["user@example.com", "a.b+tag@sub.example.co.uk"]) {
		const result = toolEmailSchema.safeParse(value);
		assert.equal(result.success, true, value);
		assert.equal(result.data, value);
	}
});

test("rejects malformed and empty values with the refine message", () => {
	for (const value of ["", "   ", "not-an-email", "user@", "@example.com", "user@@example.com"]) {
		const result = toolEmailSchema.safeParse(value);
		assert.equal(result.success, false, JSON.stringify(value));
		assert.deepEqual(result.error.issues.map((issue) => issue.message), ["Invalid email"]);
	}
});

test("rejects multi-address values", () => {
	for (const value of [
		"user@example.com, other@example.com",
		"user@example.com;other@example.com",
		"user@example.com other@example.com",
		"user@example.com\nother@example.com",
	]) {
		assert.equal(toolEmailSchema.safeParse(value).success, false, JSON.stringify(value));
	}
});
