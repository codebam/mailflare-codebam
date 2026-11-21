import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-snippet-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/parse.ts")],
	outfile: join(dir, "parse.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { buildSnippet } = await import(pathToFileURL(join(dir, "parse.mjs")).href);

test("buildSnippet prefers plain text and collapses its whitespace", () => {
	assert.equal(buildSnippet("  Hello   there\nworld  ", "<p>IGNORED</p>"), "Hello there world");
});

test("buildSnippet falls back to html when the text is blank", () => {
	assert.equal(buildSnippet("   ", "<p>From the html</p>"), "From the html");
});

test("buildSnippet drops a quoted reply before building the snippet", () => {
	assert.equal(buildSnippet("Yes, ship it.\n\n> Old message\n> And more", null), "Yes, ship it.");
});

test("buildSnippet honours the max length and tolerates no content", () => {
	assert.equal(buildSnippet("abcdefghij", null, 4), "abcd");
	assert.equal(buildSnippet(null, null, 4), "");
});
