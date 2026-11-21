import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-i18n-edges-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/i18n/utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("locale matching is exact: near misses and non-strings fall back to English", () => {
	for (const value of [
		"EN", "PT-BR", " ar ", "fr-CA", "en-US", "he",
		"constructor", 42, true, Symbol("ar"), [], ["ar"], { ar: true },
	]) {
		assert.equal(m.resolveLocale(value), "en", String(value));
	}
	// Registered codes are matched literally, including case and region subtags.
	assert.equal(m.resolveLocale("ar"), "ar");
	assert.equal(m.resolveLocale("zh-CN"), "zh-CN");
});

test("direction comes from the registered script, not from the writing system of a locale's name", () => {
	for (const code of ["ar", "ur", "fa"]) assert.equal(m.getDirection(code), "rtl", code);
	for (const code of ["en", "ru", "zh-CN", "ja", "hi", "bn", "ta"]) assert.equal(m.getDirection(code), "ltr", code);
});

test("interpolation replaces only supplied placeholders, including empty and zero values", () => {
	const messages = { "edge.mix": "a={a} b={b} a={a} c={c}" };
	assert.equal(m.translate(messages, "edge.mix", { a: 0, b: null, c: undefined }), "a=0 b= a=0 c=");
	assert.equal(m.translate(messages, "edge.mix"), "a={a} b={b} a={a} c={c}");
	assert.equal(m.translate(messages, "edge.mix", { a: "x" }), "a=x b={b} a=x c={c}");
	// A key absent from both the active catalog and English renders as the key itself.
	assert.equal(m.translate({}, "edge.unknown"), "edge.unknown");
});

test("createTranslator selects a plural variant from count and falls back to the bare key", () => {
	const catalog = {
		"edge.item.one": "{count} thing",
		"edge.item.other": "{count} things",
		"edge.partial.other": "{count} things",
		"edge.base": "Base: {count}",
	};
	const t = m.createTranslator("en", catalog);
	assert.equal(t("edge.item", { count: 1 }), "1 thing");
	assert.equal(t("edge.item", { count: 0 }), "0 things");
	assert.equal(t("edge.item", { count: 2 }), "2 things");
	// A missing CLDR category is retried as `other` before giving up on the plural.
	assert.equal(t("edge.partial", { count: 1 }), "1 things");
	// With no plural entries at all, the bare key receives the original vars.
	assert.equal(t("edge.base", { count: 3 }), "Base: 3");
	assert.equal(t("edge.base"), "Base: {count}");
});

test("the preference cookie uses its exported name and lifetime, with Secure only when asked", () => {
	assert.equal(m.LOCALE_COOKIE, "mailflare-locale");
	assert.equal(m.LOCALE_COOKIE_MAX_AGE, 60 * 60 * 24 * 365);
	const prefix = `${m.LOCALE_COOKIE}=ar; Path=/; Max-Age=${m.LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
	assert.equal(m.serializeLocaleCookie("ar", true), `${prefix}; Secure`);
	assert.equal(m.serializeLocaleCookie("ar", false), prefix);
	assert.equal(m.serializeLocaleCookie(" ar ", false), `${m.LOCALE_COOKIE}=en; Path=/; Max-Age=${m.LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`);
});
