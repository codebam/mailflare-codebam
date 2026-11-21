import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-build-snippet-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/parse.ts")],
	outfile: join(dir, "parse.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { buildSnippet } = await import(pathToFileURL(join(dir, "parse.mjs")).href);

test("buildSnippet prefers trimmed plain text to the HTML alternative", () => {
	assert.equal(buildSnippet("  Plain text wins  ", "<p>Ignored HTML</p>"), "Plain text wins");
	assert.equal(buildSnippet("   ", "<p>HTML fallback</p>"), "HTML fallback");
});

test("buildSnippet collapses whitespace and honors an explicit length bound", () => {
	assert.equal(buildSnippet("Line one\n\tLine   two", null), "Line one Line two");
	assert.equal(buildSnippet("abcdefghij", null, 4), "abcd");
	assert.equal(buildSnippet(null, null), "");
});
