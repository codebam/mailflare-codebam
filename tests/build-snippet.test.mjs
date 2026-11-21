import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-build-snippet-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/parse.ts")],
	outfile: join(dir, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { buildSnippet } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

test("plain text becomes a single-line snippet", () => {
	assert.equal(buildSnippet("Hello, world!", null), "Hello, world!");
	assert.equal(buildSnippet("  Hello,\n\n   world!  ", null), "Hello, world!");
	assert.equal(buildSnippet("My reply\n\n> Old message", null), "My reply");
});

test("HTML-only messages use decoded readable text", () => {
	assert.equal(buildSnippet(null, "<p>Hello &amp; welcome</p><p>Second line</p>"), "Hello & welcome Second line");
	assert.equal(buildSnippet(null, "<div>Hi Sam,</div><div>It&#8217;s ready &#8212; see &amp;lt;attached&amp;gt;.</div>"), "Hi Sam, It’s ready — see &lt;attached&gt;.");
});

test("plain text takes precedence over HTML when both are present", () => {
	assert.equal(buildSnippet("Plain text wins", "<p>HTML text</p>"), "Plain text wins");
	assert.equal(buildSnippet("   ", "<p>From HTML</p>"), "From HTML");
});

test("empty input produces an empty snippet", () => {
	assert.equal(buildSnippet(null, null), "");
	assert.equal(buildSnippet("", ""), "");
	assert.equal(buildSnippet("   ", null), "");
	assert.equal(buildSnippet(null, "<p>  </p>"), "");
});

test("max caps the snippet after whitespace is collapsed", () => {
	assert.equal(buildSnippet("abcdefghij", null, 3), "abc");
	assert.equal(buildSnippet("short", null, 50), "short");
	assert.equal(buildSnippet("abcdefghij", null, 0), "");
	assert.equal(buildSnippet("a  b", null, 3), "a b");
	const long = buildSnippet("x".repeat(205), null);
	assert.equal(long.length, 200);
	assert.equal(long, "x".repeat(200));
});
