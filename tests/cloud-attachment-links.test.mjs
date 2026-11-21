import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Large attachments are sent as shared download links instead of inline parts. The link
// creation itself needs a D1 binding, so stub only that seam and pin the size decisions and
// message rewriting that run before it.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-cloud-attachments-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const outfile = join(directory, "entry.mjs");
await build({
	entryPoints: [join(root, "src/lib/email/cloud-attachment-utils.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "attachment-deps",
		setup(builder) {
			builder.onLoad({ filter: /[\\/]email[\\/]attachment-policy\.ts$/ }, () => ({
				contents: "export const CLOUD_ATTACHMENT_THRESHOLD_BYTES = 3_000_000;",
				loader: "ts",
			}));
			builder.onLoad({ filter: /[\\/]email[\\/]shared-attachments\.ts$/ }, () => ({
				contents: "export async function getOrCreateSharedAttachmentUrl(_env, id, _origin) { return 'https://files.example.test/shared/' + id; }",
				loader: "ts",
			}));
		},
	}],
});
const { prepareCloudflareAttachments } = await import(pathToFileURL(outfile).href);

const env = {};
const message = (overrides = {}) => ({ subject: "Subject", headers: {}, ...overrides });
const bigFile = (overrides = {}) => ({
	filename: "big.bin",
	type: "application/octet-stream",
	content: new ArrayBuffer(3_000_001),
	storageId: "st_big",
	...overrides,
});

test("small attachments stay inline and leave the message bodies untouched", async () => {
	const file = { filename: "a.txt", type: "text/plain", content: new ArrayBuffer(5) };
	const result = await prepareCloudflareAttachments(env, [file], message({ html: "<p>Body</p>", text: "Body" }));
	assert.deepEqual(result.attachments, [file]);
	assert.equal(result.html, "<p>Body</p>");
	assert.equal(result.text, "Body");
});

test("an attachment exactly at the cloud threshold stays inline", async () => {
	const file = { filename: "edge.bin", type: "application/octet-stream", content: new ArrayBuffer(3_000_000) };
	const result = await prepareCloudflareAttachments(env, [file], message());
	assert.deepEqual(result.attachments, [file]);
});

test("large attachments become download links and drop out of the inline list", async () => {
	const small = { filename: "ok.txt", type: "text/plain", content: new ArrayBuffer(10) };
	const result = await prepareCloudflareAttachments(
		env,
		[small, bigFile({ filename: "big.zip", type: "application/zip", storageId: "st_big" })],
		message({ text: "See attached.", html: "<p>See attached.</p>" }),
	);
	assert.deepEqual(result.attachments, [small]);
	assert.match(result.text, /Files shared through Mailflare \(download links expire after 30 days\):/);
	assert.match(result.text, /big\.zip \(3\.0 MB\): https:\/\/files\.example\.test\/shared\/st_big/);
	assert.match(result.html, /<li>big\.zip \(3\.0 MB\): <a href="https:\/\/files\.example\.test\/shared\/st_big">Download file<\/a><\/li>/);
	assert.match(result.html, /<div><p>Files shared through Mailflare \(download links expire after 30 days\):<\/p><ul>/);
});

test("the original body is kept and filenames and URLs are escaped in HTML only", async () => {
	const result = await prepareCloudflareAttachments(
		env,
		[bigFile({ filename: "a&b<script>.txt", storageId: "st_x&y" })],
		message({ text: "  Original body  " }),
	);
	assert.equal(
		result.text,
		"Original body\n\nFiles shared through Mailflare (download links expire after 30 days):\n\na&b<script>.txt (3.0 MB): https://files.example.test/shared/st_x&y",
	);
	assert.match(result.html, /a&amp;b&lt;script&gt;\.txt/);
	assert.match(result.html, /https:\/\/files\.example\.test\/shared\/st_x&amp;y/);
	assert.doesNotMatch(result.html, /<script>/);
});

test("link text and HTML are generated even when the message has no bodies", async () => {
	const result = await prepareCloudflareAttachments(env, [bigFile({ filename: "s.bin", storageId: "st_s" })], message());
	assert.equal(
		result.text,
		"Files shared through Mailflare (download links expire after 30 days):\n\ns.bin (3.0 MB): https://files.example.test/shared/st_s",
	);
	assert.match(result.html, /^<div><p>Files shared through Mailflare/);
});

test("a large attachment without a storage id is rejected", async () => {
	await assert.rejects(
		() => prepareCloudflareAttachments(env, [bigFile({ storageId: undefined })], message()),
		/Large attachment was not stored in object storage/,
	);
});

test("a message too large even after linking is rejected", async () => {
	const result = prepareCloudflareAttachments(
		env,
		[bigFile()],
		message({ html: "x".repeat(4_980_000) }),
	);
	await assert.rejects(result, /Message exceeds Cloudflare's 5 MiB email size limit even with download links/);
});
