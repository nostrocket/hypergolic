import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = createRequire(new URL("../package.json", import.meta.url));
const expo = createRequire(root.resolve("expo/package.json"));
// Use the pinned Expo CLI's own SemVer implementation.
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const { valid, validRange, satisfies } = cli("semver");

export function checkVersions(manifest, bundled, installed) {
	const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
	const pinnedExpo = dependencies.expo;
	if (!valid(pinnedExpo) || installed("expo") !== pinnedExpo) {
		throw new Error("Expo must be installed at the exact version pinned in package.json.");
	}
	for (const required of ["react", "react-native"]) {
		if (!bundled[required] || !dependencies[required]) {
			throw new Error(`Missing SDK compatibility baseline for ${required}.`);
		}
	}
	const failures = [];
	let checked = 0;
	for (const name of Object.keys(dependencies)) {
		if (!Object.hasOwn(bundled, name)) continue;
		const expected = bundled[name];
		if (!validRange(expected)) throw new Error(`Invalid SDK range for ${name}.`);
		const actual = installed(name);
		if (!satisfies(actual, expected)) {
			failures.push(`${name}: installed ${actual}, SDK requires ${expected}`);
		}
		checked += 1;
	}
	if (failures.length) throw new Error(failures.join("\n"));
	return checked;
}

export function checkProject(projectRoot) {
	const project = createRequire(resolve(projectRoot, "package.json"));
	const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
	const bundled = project("expo/bundledNativeModules.json");
	const checked = checkVersions(manifest, bundled, (name) => project(`${name}/package.json`).version);
	return `Expo ${manifest.dependencies.expo}: ${checked} dependencies match the pinned SDK compatibility map.`;
}

export function runDoctor(projectRoot, run = spawnSync) {
	console.log(checkProject(projectRoot));
	console.log("The remaining Expo Doctor checks run online; latest upgrade recommendations are separate.");
	const result = run(process.execPath, [root.resolve("expo-doctor/build/index.js"), projectRoot], {
		stdio: "inherit",
		env: { ...process.env, EXPO_DOCTOR_SKIP_DEPENDENCY_VERSION_CHECK: "1" },
	});
	if (result.error) throw result.error;
	return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		process.exitCode = runDoctor(process.cwd());
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
