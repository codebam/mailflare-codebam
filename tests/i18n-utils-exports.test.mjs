import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-i18n-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/i18n/utils.ts")],
	outfile,
	bundle: true,
	platform: "neutral",
	format: "esm",
	logLevel: "silent",
});
const i18n = await import(pathToFileURL(outfile).href);

test("defaultTranslator is a ready-made English translator", () => {
	assert.equal(typeof i18n.defaultTranslator, "function");
	assert.equal(i18n.defaultTranslator("navigation.inbox"), "Inbox");
	assert.equal(i18n.defaultTranslator("common.selectedCount", { count: 2 }), "2 selected");
	// An unknown key leaves a trace rather than throwing.
	assert.equal(i18n.defaultTranslator("no.such.key"), "no.such.key");
});

test("locale cookie name and max age are exported constants", () => {
	assert.equal(i18n.LOCALE_COOKIE, "mailflare-locale");
	assert.equal(i18n.LOCALE_COOKIE_MAX_AGE, 31_536_000);
	assert.equal(
		i18n.serializeLocaleCookie("ar", true),
		`${i18n.LOCALE_COOKIE}=ar; Path=/; Max-Age=${i18n.LOCALE_COOKIE_MAX_AGE}; SameSite=Lax; Secure`,
	);
});

test("getDirection follows the registry's dir flag", () => {
	for (const locale of ["ar", "ur", "fa"]) assert.equal(i18n.getDirection(locale), "rtl", locale);
	for (const locale of ["en", "pt-BR", "fr"]) assert.equal(i18n.getDirection(locale), "ltr", locale);
});

test("loadMessages returns the bundled English catalog without reading an asset", async () => {
	let read = false;
	const messages = await i18n.loadMessages("en", async () => {
		read = true;
		throw new Error("English must not hit the asset reader");
	});
	assert.equal(read, false);
	assert.equal(messages["navigation.inbox"], "Inbox");
});

test("loadMessages reads the named catalog and reports a failed response", async () => {
	const paths = [];
	const catalog = await i18n.loadMessages("pt-BR", async (path) => {
		paths.push(path);
		return Response.json({ "navigation.inbox": "Entrada" });
	});
	assert.deepEqual(paths, ["/locales/pt-BR.json"]);
	assert.equal(catalog["navigation.inbox"], "Entrada");
	await assert.rejects(
		i18n.loadMessages("pt-BR", async () => new Response("missing", { status: 404 })),
		/Catalog for pt-BR is unavailable \(404\)/,
	);
});

test("createTranslator falls back to the English catalog when none is supplied", () => {
	const t = i18n.createTranslator("en");
	assert.equal(t("navigation.inbox"), "Inbox");
	assert.equal(t("common.selectedCount", { count: 1 }), "1 selected");
	assert.equal(t("common.selectedCount", { count: 5 }), "5 selected");
});
