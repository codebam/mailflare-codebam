import assert from "node:assert/strict";
import test from "node:test";

import { isZipSupported } from "../src/lib/import/zip-utils.ts";

test("isZipSupported reflects DecompressionStream availability", (t) => {
	const original = globalThis.DecompressionStream;
	t.after(() => {
		if (original === undefined) delete globalThis.DecompressionStream;
		else globalThis.DecompressionStream = original;
	});

	assert.equal(typeof DecompressionStream, "function");
	assert.equal(isZipSupported(), true, "Node exposes DecompressionStream, so Takeout zip import is supported");

	globalThis.DecompressionStream = undefined;
	assert.equal(isZipSupported(), false, "an environment where DecompressionStream is undefined reports zip import unsupported");

	delete globalThis.DecompressionStream;
	assert.equal(isZipSupported(), false, "an absent DecompressionStream is also unsupported");

	globalThis.DecompressionStream = original;
	assert.equal(isZipSupported(), true, "support is restored once DecompressionStream is available again");
});
