import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-compose-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/compose/compose-utils.ts")],
	outfile: join(outDir, "compose.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const compose = await import(pathToFileURL(join(outDir, "compose.mjs")).href);

test("UNDO_SEND_OPTIONS and the default are the exposed send-delay choices", () => {
	assert.deepEqual([...compose.UNDO_SEND_OPTIONS], [0, 5, 10, 15, 30]);
	assert.equal(compose.DEFAULT_UNDO_SEND_SECONDS, 15);
});

test("parseUndoSendSeconds accepts numbers and numeric strings that match an option", () => {
	assert.equal(compose.parseUndoSendSeconds(0), 0);
	assert.equal(compose.parseUndoSendSeconds(15), 15);
	assert.equal(compose.parseUndoSendSeconds(30), 30);
	assert.equal(compose.parseUndoSendSeconds("0"), 0);
	assert.equal(compose.parseUndoSendSeconds("15"), 15);
	assert.equal(compose.parseUndoSendSeconds("  10  "), 10);
});

test("parseUndoSendSeconds rejects non-options and junk", () => {
	assert.equal(compose.parseUndoSendSeconds("7"), null);
	assert.equal(compose.parseUndoSendSeconds(3), null);
	assert.equal(compose.parseUndoSendSeconds(15.5), null);
	assert.equal(compose.parseUndoSendSeconds("abc"), null);
	assert.equal(compose.parseUndoSendSeconds(""), null);
	assert.equal(compose.parseUndoSendSeconds("   "), null);
	assert.equal(compose.parseUndoSendSeconds(null), null);
	assert.equal(compose.parseUndoSendSeconds(undefined), null);
});
