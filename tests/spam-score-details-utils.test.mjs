import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-spam-score-details-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { parseSpamSignals } from "./src/components/messages/spam-score-details-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "spam-score-details-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { parseSpamSignals } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("missing, blank or malformed stored values yield an empty list", () => {
	for (const value of [null, undefined, "", "   ", "not json", "["]) {
		assert.deepEqual(parseSpamSignals(value), [], String(value));
	}
});

test("valid signals round-trip with their optional metadata", () => {
	const signals = [
		{ id: "spf-fail", score: 3, reason: "SPF failed" },
		{ id: "urlhaus", score: 5, reason: "Listed URL", metadata: { url: "https://example.com" } },
	];
	assert.deepEqual(parseSpamSignals(JSON.stringify(signals)), signals);
	assert.deepEqual(parseSpamSignals("[]"), []);
});

test("non-array JSON is ignored", () => {
	for (const value of ['{"id":"x","score":1,"reason":"y"}', "42", '"text"', "true", "null"]) {
		assert.deepEqual(parseSpamSignals(value), [], value);
	}
});

test("array entries without a valid id, numeric score or reason are dropped", () => {
	const kept = { id: "kept", score: 0, reason: "still a signal", metadata: { source: "test" } };
	const invalid = [null, 7, "signal", [], {}, { id: 1, score: 2, reason: "x" }, { id: "x", score: "2", reason: "y" }, { id: "x", score: 2, reason: null }];
	assert.deepEqual(parseSpamSignals(JSON.stringify([...invalid, kept])), [kept]);
});
