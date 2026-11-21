import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-cloud-attachments-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The helper is deterministic once the URL generator is stubbed; the policy
// constant below mirrors src/lib/email/attachment-policy.ts (3_000_000 bytes).
await build({
	entryPoints: [join(root, "src/lib/email/cloud-attachment-utils.ts")],
	outfile: join(dir, "cloud.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
	plugins: [{
		name: "stub-cloud-dependencies",
		setup(builder) {
			builder.onResolve({ filter: /shared-attachments$/ }, () => ({ path: "shared", namespace: "mock" }));
			builder.onResolve({ filter: /attachment-policy$/ }, () => ({ path: "policy", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
				contents: path === "shared"
					? `export async function getOrCreateSharedAttachmentUrl(env, id, origin) {
	globalThis.__cloudUrlCalls.push({ id, origin });
	return "https://files.example.test/s/" + id + "?a=1&b='x'";
}`
					: "export const CLOUD_ATTACHMENT_THRESHOLD_BYTES = 3_000_000;",
				loader: "js",
			}));
		},
	}],
});

const { prepareCloudflareAttachments } = await import(pathToFileURL(join(dir, "cloud.mjs")).href);

function attachment(filename, size, storageId) {
	return {
		filename,
		type: "text/plain",
		content: new ArrayBuffer(size),
		...(storageId ? { storageId } : {}),
	};
}

function message(overrides = {}) {
	return {
		subject: "Subject",
		text: "Body text",
		html: "<p>Body text</p>",
		headers: { From: "a@example.com" },
		...overrides,
	};
}

test("inline attachments keep the original message content", async () => {
	globalThis.__cloudUrlCalls = [];
	const small = attachment("note.txt", 16);
	const input = message();
	const result = await prepareCloudflareAttachments({}, [small], input);

	assert.deepEqual(result.attachments, [small]);
	assert.equal(result.text, input.text);
	assert.equal(result.html, input.html);
	assert.deepEqual(globalThis.__cloudUrlCalls, []);
});

test("oversized attachments become escaped download links while small ones stay inline", async () => {
	globalThis.__cloudUrlCalls = [];
	const small = attachment("small.txt", 16);
	const big = attachment(`big<&"'>.txt`, 3_000_001, "share-1");
	const result = await prepareCloudflareAttachments(
		{},
		[big, small],
		message({ publicOrigin: "https://origin.example.test" }),
	);

	assert.deepEqual(result.attachments, [small]);
	assert.deepEqual(globalThis.__cloudUrlCalls, [{ id: "share-1", origin: "https://origin.example.test" }]);

	const url = "https://files.example.test/s/share-1?a=1&b='x'";
	assert.equal(
		result.text,
		"Body text\n\nFiles shared through Mailflare (download links expire after 30 days):\n\n" +
			`big<&"'>.txt (3.0 MB): ${url}`,
	);
	assert.equal(
		result.html,
		'<p>Body text</p><div><p>Files shared through Mailflare (download links expire after 30 days):</p>' +
			'<ul><li>big&lt;&amp;&quot;&#39;&gt;.txt (3.0 MB): ' +
			'<a href="https://files.example.test/s/share-1?a=1&amp;b=&#39;x&#39;">Download file</a></li></ul></div>',
	);
});

test("an oversized attachment without object storage is rejected", async () => {
	globalThis.__cloudUrlCalls = [];
	await assert.rejects(
		() => prepareCloudflareAttachments({}, [attachment("big.txt", 3_000_001)], message()),
		{ message: "Large attachment was not stored in object storage" },
	);
	assert.deepEqual(globalThis.__cloudUrlCalls, []);
});

test("a message above the size limit with no attachments is rejected", async () => {
	await assert.rejects(
		() => prepareCloudflareAttachments({}, [], message({ text: "x".repeat(4_980_000), html: "" })),
		{ message: "Message exceeds Cloudflare's 5 MiB email size limit" },
	);
});

test("a message too large even after linking attachments is rejected", async () => {
	globalThis.__cloudUrlCalls = [];
	await assert.rejects(
		() => prepareCloudflareAttachments(
			{},
			[attachment("big.txt", 3_000_001, "share-2")],
			message({ text: "x".repeat(4_975_000), html: "" }),
		),
		{ message: "Message exceeds Cloudflare's 5 MiB email size limit even with download links" },
	);
});
