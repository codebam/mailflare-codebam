import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-latest-content-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/reply-content-utils.ts")],
	outfile: join(dir, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { getLatestEmailContent } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

test("null and undefined produce empty content", () => {
	assert.equal(getLatestEmailContent(null), "");
	assert.equal(getLatestEmailContent(undefined), "");
});

test("empty and whitespace-only input produce empty content", () => {
	assert.equal(getLatestEmailContent(""), "");
	assert.equal(getLatestEmailContent("   \n  \r\n "), "");
});

test("content without a quote separator is returned trimmed with normalized newlines", () => {
	assert.equal(getLatestEmailContent("  Hello\r\nworld  \r\n"), "Hello\nworld");
});

test("an 'On ... wrote:' marker cuts off the quoted thread", () => {
	const content = "My reply\n\nOn Tue, 21 Jan 2026 10:00 AM Alice <alice@example.com> wrote:\n> Older message";
	assert.equal(getLatestEmailContent(content), "My reply");
});

test("an 'Original Message' separator cuts off the quoted thread", () => {
	const content = "My reply\n\n-----Original Message-----\nFrom: Alice <alice@example.com>\nSent: Tue, 21 Jan 2026 10:00 AM\nSubject: Re: Hi\n> Older message";
	assert.equal(getLatestEmailContent(content), "My reply");
});

test("an underscore separator cuts off the quoted thread", () => {
	const content = "My reply\n\n________________________\nFrom: Alice <alice@example.com>\n> Older message";
	assert.equal(getLatestEmailContent(content), "My reply");
});

test("a bare '>' quote line cuts off the quoted thread", () => {
	assert.equal(getLatestEmailContent("My reply\n> Older message"), "My reply");
});
