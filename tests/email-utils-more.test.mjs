import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-email-utils-more-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/attachment-text.ts")],
	outfile: join(dir, "attachment-text.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
const { extractAttachmentText, MAX_ATTACHMENT_TEXT_CHARS, MAX_ATTACHMENT_TEXT_INPUT_BYTES, MAX_ATTACHMENT_TEXT_ROWS } =
	await import(pathToFileURL(join(dir, "attachment-text.mjs")).href);

const encode = (text) => new TextEncoder().encode(text).buffer;

test("extractAttachmentText normalises media type parameters and uses filename fallbacks", () => {
	assert.equal(extractAttachmentText("note.txt", " TEXT/PLAIN; charset=UTF-8 ", encode("caf\u00e9")), "caf\u00e9");
	assert.equal(extractAttachmentText("LOG.LOG", "application/octet-stream", encode("a line")), "a line");
	assert.equal(extractAttachmentText("notes.csv", "APPLICATION/CSV", encode("a,b\n1,2")), "a,b\n1,2");
	assert.equal(extractAttachmentText("x.unknown", "Text/X-Weird; charset=utf-8", encode("hello")), "hello");
});

test("extractAttachmentText strips HTML structure and decodes entities", () => {
	assert.equal(extractAttachmentText("page.html", "text/html", encode("<p>one<br>two</p>")), "one\ntwo");
	assert.equal(extractAttachmentText("s.html", "text/html", encode("<script>bad()</script><style>.x{}</style><p>keep</p>")), "keep");
	assert.equal(extractAttachmentText("e.html", "text/html", encode("&nbsp;&lt;&gt;&quot;&#39;&amp;")), `<>"'&`);
	assert.equal(extractAttachmentText("blank.html", "text/html", encode("<p>&nbsp;</p>")), null);
	// A .htm filename selects HTML stripping even when the MIME type is plain text.
	assert.equal(extractAttachmentText("by-name.htm", "text/plain", encode("<p>named</p>")), "named");
	// But HTML detection alone does not make a binary-typed file text-ish.
	assert.equal(extractAttachmentText("by-name.htm", "application/octet-stream", encode("<p>named</p>")), null);
});

test("extractAttachmentText drops null bytes and rejects empty or oversized input", () => {
	assert.equal(extractAttachmentText("nul.txt", "text/plain", encode("a\u0000b")), "ab");
	assert.equal(extractAttachmentText("empty.txt", "text/plain", new ArrayBuffer(0)), null);
	assert.equal(extractAttachmentText("zeros.txt", "text/plain", new ArrayBuffer(MAX_ATTACHMENT_TEXT_INPUT_BYTES)), null);
	assert.equal(extractAttachmentText("over.txt", "text/plain", new ArrayBuffer(MAX_ATTACHMENT_TEXT_INPUT_BYTES + 1)), null);
	assert.equal(MAX_ATTACHMENT_TEXT_ROWS, 50);
});

test("extractAttachmentText caps a long attachment at the indexed maximum", () => {
	const text = extractAttachmentText("long.txt", "text/plain", encode("x".repeat(MAX_ATTACHMENT_TEXT_CHARS + 10)));
	assert.equal(text.length, MAX_ATTACHMENT_TEXT_CHARS);
});
