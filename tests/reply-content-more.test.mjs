import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-reply-content-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/reply-content-utils.ts")],
	outfile: join(dir, "reply.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { splitRepliedEmailContent } = await import(pathToFileURL(join(dir, "reply.mjs")).href);

test("content without quote markers stays entirely in the latest part", () => {
	assert.deepEqual(splitRepliedEmailContent("Hello\nWorld"), {
		latestContent: "Hello\nWorld",
		quotedContent: [],
	});
	assert.deepEqual(splitRepliedEmailContent(null), { latestContent: "", quotedContent: [] });
});

test("a wrote marker splits the reply and attributes the quoted message", () => {
	const content = [
		"Thanks!",
		"",
		"On Jan 1, 2026 at 10:00 AM Alice <alice@example.com> wrote:",
		"> Older text",
		"> Second line",
	].join("\n");
	assert.deepEqual(splitRepliedEmailContent(content, { ownAddress: "alice@example.com" }), {
		latestContent: "Thanks!",
		quotedContent: [{
			dateLine: "Jan 1",
			direction: "sent",
			content: "Older text\nSecond line",
			quotedContent: [],
		}],
	});
});

test("a bare quote block uses an unknown time and received direction", () => {
	assert.deepEqual(
		splitRepliedEmailContent("Reply here\n> Quoted one\n> Quoted two", { ownAddress: "alice@example.com" }),
		{
			latestContent: "Reply here",
			quotedContent: [{
				dateLine: "Unknown time",
				direction: "received",
				content: "Quoted one\nQuoted two",
				quotedContent: [],
			}],
		},
	);
});

test("Original Message headers supply the quoted date and direction", () => {
	const content = [
		"My reply",
		"-----Original Message-----",
		"From: Bob <bob@example.com>",
		"Sent: Tuesday, January 2, 2026 9:00 AM",
		"Subject: Re: hi",
		"",
		"Original body",
	].join("\n");
	assert.deepEqual(splitRepliedEmailContent(content, { ownAddress: "alice@example.com" }), {
		latestContent: "My reply",
		quotedContent: [{
			dateLine: "Tuesday, January 2, 2026 9:00 AM",
			direction: "received",
			content: "Original body",
			quotedContent: [],
		}],
	});
});

test("an underscore separator reads Sent and From headers", () => {
	const content = [
		"Top reply",
		"________________________________",
		"From: alice@example.com",
		"Sent: Monday, January 5, 2026 8:15 AM",
		"Old body",
	].join("\n");
	assert.deepEqual(splitRepliedEmailContent(content, { ownAddress: "alice@example.com" }), {
		latestContent: "Top reply",
		quotedContent: [{
			dateLine: "Monday, January 5, 2026 8:15 AM",
			direction: "sent",
			content: "From: alice@example.com\nSent: Monday, January 5, 2026 8:15 AM\nOld body",
			quotedContent: [],
		}],
	});
});

test("nested quotes are preserved as nested quoted content", () => {
	const content = [
		"Latest",
		"On Tue, Jan 6, 2026 at 11:00 AM Bob <bob@example.com> wrote:",
		"> Inner latest",
		"> On Mon, Jan 5, 2026 at 9:00 AM Alice <alice@example.com> wrote:",
		"> > Deep quote",
	].join("\n");
	assert.deepEqual(splitRepliedEmailContent(content, { ownAddress: "alice@example.com" }), {
		latestContent: "Latest",
		quotedContent: [{
			dateLine: "Tue, Jan 6",
			direction: "received",
			content: "Inner latest",
			quotedContent: [{
				dateLine: "Mon, Jan 5",
				direction: "sent",
				content: "Deep quote",
				quotedContent: [],
			}],
		}],
	});
});

test("CRLF input is normalized before splitting", () => {
	assert.deepEqual(splitRepliedEmailContent("Top\r\n> Quoted"), {
		latestContent: "Top",
		quotedContent: [{
			dateLine: "Unknown time",
			direction: "received",
			content: "Quoted",
			quotedContent: [],
		}],
	});
});
