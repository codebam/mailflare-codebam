import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-approval-hash-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Snapshot and attachment digests share this pure helper; pin it directly
// without dragging the database-backed approval flow into the test.
const source = readFileSync(join(root, "src/lib/agent/approvals/utils.ts"), "utf8");
const helper = source.match(/async function sha256\([\s\S]*?\n\}/)?.[0];
assert.ok(helper, "sha256 helper is present in approvals/utils.ts");
await build({
	stdin: { contents: `${helper}\nexport { sha256 };`, resolveDir: root, sourcefile: "approval-hash-entry.ts", loader: "ts" },
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	packages: "external",
	logLevel: "silent",
});
const { sha256 } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("sha256 returns lowercase hex for known digests", async () => {
	assert.equal(await sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(await sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("strings are digested as UTF-8, matching an ArrayBuffer of the same bytes", async () => {
	for (const text of ["Grüße 🌍", JSON.stringify({ subject: "Re: café", to: "a@example.com" })]) {
		const bytes = new TextEncoder().encode(text);
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		assert.equal(await sha256(text), createHash("sha256").update(text, "utf8").digest("hex"));
		assert.equal(await sha256(buffer), await sha256(text));
	}
	assert.notEqual(await sha256("draft A"), await sha256("draft B"));
});
