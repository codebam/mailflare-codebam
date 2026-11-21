import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-reply-split-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { r: join(root, "src/lib/email/reply-content-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { getLatestEmailContent, splitRepliedEmailContent } = await import(pathToFileURL(join(dir, "r.mjs")).href);

test("a body with no reply marker is all latest content", () => {
	assert.deepEqual(splitRepliedEmailContent("  Thanks — that works.\n"), {
		latestContent: "Thanks — that works.",
		quotedContent: [],
	});
});

test("On … wrote: keeps the new text and strips the quote prefix", () => {
	const parts = splitRepliedEmailContent([
		"Thanks, that works.",
		"",
		"On Tue, 2 Dec 2025 09:15:00 -0500, Sam <sam@example.com> wrote:",
		"> The quoted line.",
		"> Second line.",
	].join("\n"));

	assert.equal(parts.latestContent, "Thanks, that works.");
	assert.equal(parts.quotedContent.length, 1);
	assert.deepEqual(parts.quotedContent[0], {
		dateLine: "Tue, 2 Dec 2025 09:15:00 -0500",
		direction: "received",
		content: "The quoted line.\nSecond line.",
		quotedContent: [],
	});
});

test("a quoted message from the user's own address is marked sent", () => {
	const parts = splitRepliedEmailContent(
		"Reply.\nOn Tue, 2 Dec 2025 09:15:00 -0500, Sam <sam@example.com> wrote:\n> Text.",
		{ ownAddress: "SAM@Example.com" },
	);
	assert.equal(parts.quotedContent[0].direction, "sent");
});

test("-----Original Message----- reads the From and Sent headers", () => {
	const parts = splitRepliedEmailContent([
		"Please review.",
		"-----Original Message-----",
		"From: Alex <alex@example.com>",
		"Sent: Mon, 1 Dec 2025 08:00:00 -0500",
		"Subject: Re: Thing",
		"",
		"> Original text here.",
	].join("\n"));

	assert.equal(parts.latestContent, "Please review.");
	assert.equal(parts.quotedContent.length, 1);
	assert.equal(parts.quotedContent[0].dateLine, "Mon, 1 Dec 2025 08:00:00 -0500");
	assert.equal(parts.quotedContent[0].direction, "received");
	assert.ok(parts.quotedContent[0].content.includes("Original text here."));
});

test("an underscore separator prefers Sent over Date", () => {
	const parts = splitRepliedEmailContent([
		"My answer.",
		"________________________________",
		"From: Sam <sam@example.com>",
		"Sent: Friday, November 21, 2025 9:00 AM",
		"Date: Friday, November 21, 2025 8:00 AM",
		"> Earlier text",
	].join("\n"));

	assert.equal(parts.latestContent, "My answer.");
	assert.equal(parts.quotedContent.length, 1);
	assert.equal(parts.quotedContent[0].dateLine, "Friday, November 21, 2025 9:00 AM");
	assert.equal(parts.quotedContent[0].direction, "received");
	// The header lines and the > line are split again by buildQuotedContent.
	assert.ok(parts.quotedContent[0].content.includes("From: Sam <sam@example.com>"));
	assert.equal(parts.quotedContent[0].quotedContent[0].content, "Earlier text");
});

test("a bare > quote with no marker is still separated, with an unknown time", () => {
	const parts = splitRepliedEmailContent("Reply text.\n> quoted without a marker\n");
	assert.equal(parts.latestContent, "Reply text.");
	assert.deepEqual(parts.quotedContent[0], {
		dateLine: "Unknown time",
		direction: "received",
		content: "quoted without a marker",
		quotedContent: [],
	});
});

test("nested replies stay nested", () => {
	const parts = splitRepliedEmailContent([
		"Newest reply.",
		"",
		"On Tue, 2 Dec 2025 09:15:00 -0500, Sam <sam@example.com> wrote:",
		"> Earlier reply.",
		">",
		"> On Mon, 1 Dec 2025 09:00:00 -0500, Pat <pat@example.com> wrote:",
		"> > Original note.",
	].join("\n"));

	const [outer] = parts.quotedContent;
	assert.equal(outer.content, "Earlier reply.");
	assert.equal(outer.quotedContent.length, 1);
	assert.equal(outer.quotedContent[0].dateLine, "Mon, 1 Dec 2025 09:00:00 -0500");
	assert.equal(outer.quotedContent[0].content, "Original note.");
});

test("CRLF line endings normalise before splitting", () => {
	const parts = splitRepliedEmailContent("First line.\r\nSecond line.\r\n");
	assert.equal(parts.latestContent, "First line.\nSecond line.");
});

test("getLatestEmailContent returns only the new text", () => {
	const content = "My reply.\nOn Tue, 2 Dec 2025 09:15:00 -0500, Sam <s@example.com> wrote:\n> Quoted.";
	assert.equal(getLatestEmailContent(content), "My reply.");
	assert.equal(getLatestEmailContent(null), "");
	assert.equal(getLatestEmailContent(undefined), "");
});
