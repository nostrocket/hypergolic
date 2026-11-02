import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = createRequire(new URL("../../package.json", import.meta.url));
const expo = createRequire(root.resolve("expo/package.json"));
const config = createRequire(expo.resolve("@expo/config"));
const { modifyConfigAsync } = config("./Config.js");
const options = { skipSDKVersionRequirement: true, skipPlugins: true };

async function fixture(value, action) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "expo-config-merge-"));
	const file = path.join(directory, "app.json");
	try {
		await writeFile(
			path.join(directory, "package.json"),
			'{"name":"config-merge-fixture","version":"1.0.0"}',
		);
		await writeFile(
			file,
			JSON.stringify({
				expo: { name: "Config fixture", slug: "config-fixture", ...value },
			}),
		);
		await action(directory, file);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function merge(directory, changes, dryRun = true) {
	return modifyConfigAsync(directory, changes, options, { dryRun });
}

test("Expo resolves the real maintained merge implementation and not deepmerge", () => {
	assert.equal(config("@fastify/deepmerge/package.json").version, "3.2.4");
	assert.throws(() => config.resolve("deepmerge"), {
		code: "MODULE_NOT_FOUND",
	});
});

test("nested arrays concatenate, fields merge and returned values do not alias caller input", async () => {
	await fixture(
		{ extra: { list: [1], nested: { first: true } } },
		async (directory) => {
			const changes = { extra: { list: [2], nested: { second: true } } };
			const result = await merge(directory, changes);
			assert.deepEqual(result.config.extra, {
				list: [1, 2],
				nested: { first: true, second: true },
			});
			result.config.extra.list.push(3);
			result.config.extra.nested.second = false;
			assert.deepEqual(changes, {
				extra: { list: [2], nested: { second: true } },
			});
		},
	);
});

test("explicit undefined removes existing fields from persisted config", async () => {
	await fixture(
		{ description: "previous", extra: { remove: true, keep: true } },
		async (directory, file) => {
			await merge(
				directory,
				{ description: undefined, extra: { remove: undefined } },
				false,
			);
			const saved = JSON.parse(await readFile(file, "utf8")).expo;
			assert.equal(Object.hasOwn(saved, "description"), false);
			assert.deepEqual(saved.extra, { keep: true });
		},
	);
});

test("existing plugin options merge once and preserve plugin order", async () => {
	await fixture(
		{
			plugins: [
				["example-plugin", { list: [1], nested: { a: 1 } }],
				"other-plugin",
			],
		},
		async (directory) => {
			const result = await merge(directory, {
				plugins: [
					["example-plugin", { list: [2], nested: { b: 2 } }],
					"new-plugin",
				],
			});
			assert.deepEqual(result.config.plugins, [
				["example-plugin", { list: [1, 2], nested: { a: 1, b: 2 } }],
				"other-plugin",
				"new-plugin",
			]);
		},
	);
});

test("plugin shorthand gains options and an existing tuple survives a shorthand update", async () => {
	await fixture(
		{ plugins: ["example-plugin", ["other-plugin", { value: 1 }]] },
		async (directory) => {
			const result = await merge(directory, {
				plugins: [["example-plugin", { enabled: true }], "other-plugin"],
			});
			assert.deepEqual(result.config.plugins, [
				["example-plugin", { enabled: true }],
				["other-plugin", { value: 1 }],
			]);
		},
	);
});

for (const lane of ["config", "plugin"])
	test(`null placeholders cannot inherit attacker properties in ${lane} merge`, async () => {
		const payload = JSON.parse('{"__proto__":{"mergeSentinel":true}}');
		const value =
			lane === "config"
				? { extra: { session: null } }
				: { plugins: [["example-plugin", { session: null }]] };
		await fixture(value, async (directory) => {
			const changes =
				lane === "config"
					? { extra: { session: payload } }
					: { plugins: [["example-plugin", { session: payload }]] };
			const result = await merge(directory, changes);
			const session =
				lane === "config"
					? result.config.extra.session
					: result.config.plugins[0][1].session;
			assert.equal(Object.getPrototypeOf(session), Object.prototype);
			assert.equal(session.mergeSentinel, undefined);
			assert.equal({}.mergeSentinel, undefined);
		});
	});

test("own dangerous key names are dropped from existing config data", async () => {
	const value = JSON.parse(
		'{"__proto__":{"mergeSentinel":true},"constructor":"data","prototype":{"value":1}}',
	);
	await fixture(value, async (directory) => {
		const result = await merge(directory, { description: "public" });
		for (const key of ["__proto__", "constructor", "prototype"])
			assert.equal(Object.hasOwn(result.config, key), false);
		assert.equal(Object.getPrototypeOf(result.config), Object.prototype);
		assert.equal(result.config.mergeSentinel, undefined);
	});
});

test("enumerable symbols survive and sparse array normalization preserves serialized JSON", async () => {
	await fixture({}, async (directory, file) => {
		const symbol = Symbol("public configuration");
		const changes = { extra: { [symbol]: { value: 1 }, list: new Array(1) } };
		const result = await merge(directory, changes, false);
		assert.deepEqual(result.config.extra[symbol], { value: 1 });
		assert.notEqual(result.config.extra[symbol], changes.extra[symbol]);
		assert.equal(0 in result.config.extra.list, true);
		assert.equal(result.config.extra.list[0], undefined);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")).expo.extra, {
			list: [null],
		});
	});
});
