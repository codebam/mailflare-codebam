import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-zip-support-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/import/zip-utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { isZipSupported } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("isZipSupported reflects whether DecompressionStream exists", () => {
	const original = globalThis.DecompressionStream;
	try {
		globalThis.DecompressionStream = undefined;
		assert.equal(isZipSupported(), false);
		globalThis.DecompressionStream = class FakeDecompressionStream {};
		assert.equal(isZipSupported(), true);
	} finally {
		if (original === undefined) delete globalThis.DecompressionStream;
		else globalThis.DecompressionStream = original;
	}
});
