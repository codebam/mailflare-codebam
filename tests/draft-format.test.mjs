import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-draft-format-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/agent/draft-format.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { formatAgentDraftBody } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("normalizes line endings, collapses blank runs, then trims", () => {
	assert.equal(formatAgentDraftBody("  Hello\r\nWorld  \n\n\n\nAfter  ").text, "Hello\nWorld  \n\nAfter");
});

test("strips fenced-code lines and markdown headings", () => {
	assert.equal(formatAgentDraftBody("```md\n# Title\n## Sub\nBody\n```").text, "Title\nSub\nBody");
	assert.equal(formatAgentDraftBody("   ```ts\n### Heading\ntext").text, "Heading\ntext");
});

test("converts markdown list markers to bullets", () => {
	assert.equal(formatAgentDraftBody("- one\n* two\n+ three\n   - nested").text, "• one\n• two\n• three\n• nested");
});

test("flattens links and inline emphasis", () => {
	assert.equal(
		formatAgentDraftBody("See [Docs](https://example.com/docs) and **bold** __strong__ *em* _it_ ~~gone~~ `code`").text,
		"See Docs (https://example.com/docs) and bold strong em it gone code",
	);
});

test("underscore emphasis spans to the next underscore on the line", () => {
	assert.equal(formatAgentDraftBody("a_b and _em_").text, "ab and em_");
});

test("keeps signatures and quoted lines verbatim while folding blank runs", () => {
	assert.equal(
		formatAgentDraftBody("Thanks!\n\n> On Mon, Alice wrote:\n> Please review.\n\n-- \nSean\n\n\n\n").text,
		"Thanks!\n\n> On Mon, Alice wrote:\n> Please review.\n\n-- \nSean",
	);
});

test("only strips markers at line starts", () => {
	assert.equal(formatAgentDraftBody("use # for tags and a * literal").text, "use # for tags and a * literal");
});

test("html escapes text, keeps line breaks, and empty input stays empty", () => {
	assert.equal(
		formatAgentDraftBody("a < b & c\n\"quoted\"").html,
		'<div>a &lt; b &amp; c<br>&quot;quoted&quot;</div>',
	);
	assert.deepEqual(formatAgentDraftBody("   \n\n  "), { text: "", html: "" });
});

test("formatAgentDraftBody strips inline markdown emphasis", () => {
	assert.deepEqual(formatAgentDraftBody("Hello **world**"), {
		text: "Hello world",
		html: "<div>Hello world</div>",
	});
	assert.equal(formatAgentDraftBody("__bold__ _italic_ ~~gone~~ `mono`").text, "bold italic gone mono");
});

test("formatAgentDraftBody converts headings, bullets and links", () => {
	assert.equal(formatAgentDraftBody("## Title").text, "Title");
	assert.deepEqual(formatAgentDraftBody("- one\n- two"), {
		text: "• one\n• two",
		html: "<div>• one<br>• two</div>",
	});
	assert.equal(formatAgentDraftBody("[docs](https://example.com)").text, "docs (https://example.com)");
});

test("formatAgentDraftBody drops code fences, collapses blank lines and trims", () => {
	assert.equal(formatAgentDraftBody("```js\nlet x=1;\n```").text, "let x=1;");
	assert.equal(formatAgentDraftBody("  a\r\n\r\n\r\n\r\nb  ").text, "a\n\nb");
	assert.deepEqual(formatAgentDraftBody(""), { text: "", html: "" });
});

test("formatAgentDraftBody escapes html in the derived alternative", () => {
	assert.equal(formatAgentDraftBody("a < b & c > d").html, "<div>a &lt; b &amp; c &gt; d</div>");
});

test("formatAgentDraftBody strips markdown furniture without losing the words", () => {
	const input = [
		"# Heading",
		"",
		"```js",
		"- **bold** and _italic_ and ~~gone~~",
		"- [label](https://example.com/x) and `code`",
		"",
		"",
		"__strong__ tail",
	].join("\r\n");
	assert.equal(formatAgentDraftBody(input).text, [
		"Heading",
		"",
		"• bold and italic and gone",
		"• label (https://example.com/x) and code",
		"",
		"strong tail",
	].join("\n"));
});

test("formatAgentDraftBody returns composer HTML matching its plain text", () => {
	const { text, html } = formatAgentDraftBody("**<b> &** `x`\n\nnext");
	assert.equal(text, "<b> & x\n\nnext");
	assert.equal(html, "<div>&lt;b&gt; &amp; x<br><br>next</div>");
});

test("blank draft bodies produce empty text and empty HTML", () => {
	const { text, html } = formatAgentDraftBody("  \n\n  ");
	assert.equal(text, "");
	assert.equal(html, "");
});
