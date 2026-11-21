import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-brand-icon-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/app/api/branding/utils.ts")],
	outfile: join(dir, "utils.mjs"),
	bundle: true, platform: "node", format: "esm", logLevel: "silent",
});
const { isBrandingIcon, BRANDING_ICON_TYPES, MAX_BRANDING_ICON_SIZE } = await import(pathToFileURL(join(dir, "utils.mjs")).href);

test("isBrandingIcon accepts File-like values but rejects form strings and plain objects", () => {
	assert.equal(isBrandingIcon(null), false);
	assert.equal(isBrandingIcon(""), false);
	assert.equal(isBrandingIcon("logo.png"), false);
	assert.equal(isBrandingIcon(42), false);
	assert.equal(isBrandingIcon({}), false);
	assert.equal(isBrandingIcon({ size: 1, type: "image/png" }), false);
	assert.equal(isBrandingIcon(new File(["x"], "logo.png", { type: "image/png" })), true);
	assert.equal(isBrandingIcon({ arrayBuffer: async () => new ArrayBuffer(1), size: 1, type: "image/png" }), true);
});

test("isBrandingIcon is a shape guard only: the route still owns the size and type checks", () => {
	assert.equal(isBrandingIcon(new File([], "empty.png")), true);
	assert.equal(isBrandingIcon(new File(["x"], "notes.txt", { type: "text/plain" })), true);
});

test("the icon limits pin the accepted image types and the 2 MB cap", () => {
	assert.equal(MAX_BRANDING_ICON_SIZE, 2 * 1024 * 1024);
	assert.deepEqual(BRANDING_ICON_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
});
