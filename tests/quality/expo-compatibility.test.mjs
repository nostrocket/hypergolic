import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkProject, checkVersions, runDoctor } from "../../scripts/check-expo.mjs";

const root = createRequire(new URL("../../package.json", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = root("./package.json");
const bundled = root("expo/bundledNativeModules.json");
const installed = (name) => root(`${name}/package.json`).version;

function withVersion(name, version) {
	return (dependency) => dependency === name ? version : installed(dependency);
}

test("installed packages match the shipped SDK map without requesting latest releases", () => {
	assert.match(checkProject(projectRoot), /dependencies match the pinned SDK/);
	assert.ok(checkVersions(manifest, bundled, installed) >= 15);
});

test("native packages that are too old or from a newer SDK fail, even with an exclusion", () => {
	const excluded = { ...manifest, expo: { install: { exclude: ["expo-sqlite"] } } };
	for (const version of ["57.0.0", "59.0.0"]) {
		assert.throws(() => checkVersions(excluded, bundled, withVersion("expo-sqlite", version)), /expo-sqlite: installed/);
	}
});

test("React and React Native incompatibilities fail", () => {
	for (const name of ["react", "react-native"]) {
		assert.throws(() => checkVersions(manifest, bundled, withVersion(name, "99.0.0")), new RegExp(`${name}: installed`));
	}
});

test("compatible patch releases pass without requiring an upstream latest version", () => {
	const patch = installed("expo-sqlite").split(".");
	patch[2] = String(Number(patch[2]) + 1);
	assert.ok(checkVersions(manifest, bundled, withVersion("expo-sqlite", patch.join("."))));
});

test("mapped development dependencies are also checked", () => {
	const changed = { ...manifest, devDependencies: { ...manifest.devDependencies, "react-dom": "1.0.0" } };
	assert.throws(() => checkVersions(changed, bundled, withVersion("react-dom", "1.0.0")), /react-dom: installed/);
});

test("missing packages, damaged SDK maps and mismatched Expo installs fail closed", () => {
	assert.throws(() => checkVersions(manifest, {}, installed), /Missing SDK compatibility baseline/);
	assert.throws(() => checkVersions(manifest, { ...bundled, react: "invalid" }, installed), /Invalid SDK range/);
	assert.throws(() => checkVersions(manifest, bundled, withVersion("expo", "99.0.0")), /exact version pinned/);
	assert.throws(() => checkVersions(manifest, bundled, () => { throw new Error("Missing installed package"); }), /Missing installed package/);
});

test("other Doctor failures, launch errors and signal termination remain blocking", () => {
	assert.equal(runDoctor(projectRoot, (_command, args, options) => {
		assert.ok(args[0].endsWith("expo-doctor/build/index.js"));
		assert.equal(options.env.EXPO_DOCTOR_SKIP_DEPENDENCY_VERSION_CHECK, "1");
		return { status: 1 };
	}), 1);
	assert.equal(runDoctor(projectRoot, () => ({ status: null, signal: "SIGTERM" })), 1);
	assert.equal(runDoctor(projectRoot, () => ({ status: 0 })), 0);
	assert.throws(() => runDoctor(projectRoot, () => ({ error: new Error("Launch failed") })), /Launch failed/);
});
