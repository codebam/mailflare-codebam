import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-compose-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/compose/compose-utils.ts")],
	outfile: join(outDir, "compose-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const utils = await import(pathToFileURL(join(outDir, "compose-utils.mjs")).href);

test("UNDO_SEND_OPTIONS and its default are the offered whole-second delays", () => {
	assert.deepEqual([...utils.UNDO_SEND_OPTIONS], [0, 5, 10, 15, 30]);
	assert.equal(utils.DEFAULT_UNDO_SEND_SECONDS, 15);
	assert.ok(utils.UNDO_SEND_OPTIONS.includes(utils.DEFAULT_UNDO_SEND_SECONDS));
});

test("parseUndoSendSeconds accepts an offered delay as a number or numeric string", () => {
	for (const value of [0, 5, 10, 15, 30, "0", "5", "10", "15", "30"]) {
		assert.equal(utils.parseUndoSendSeconds(value), Number(value), String(value));
	}
	assert.equal(utils.parseUndoSendSeconds(" 10 "), 10);
	assert.equal(utils.parseUndoSendSeconds("05"), 5);
	assert.equal(utils.parseUndoSendSeconds("1e1"), 10);
});

test("parseUndoSendSeconds rejects anything that is not an offered delay", () => {
	for (const value of [1, 3, 29, 31, -1, "3", "31", "", "   ", "soon", "5s", "NaN", NaN, Infinity, null, undefined, true, false, [], {}]) {
		assert.equal(utils.parseUndoSendSeconds(value), null, String(value));
	}
});
