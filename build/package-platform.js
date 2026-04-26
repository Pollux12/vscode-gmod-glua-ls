import { spawnSync } from "child_process";

const [, , packageKind] = process.argv;

if (!new Set(["dev", "release"]).has(packageKind)) {
    console.error("Usage: node ./build/package-platform.js <dev|release>");
    process.exit(1);
}

function getTarget() {
    if (process.platform === "win32") {
        return "win32-x64";
    }

    if (process.platform === "darwin") {
        return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    }

    if (process.platform === "linux") {
        return "linux-x64";
    }

    throw new Error(`Unsupported packaging platform: ${process.platform}-${process.arch}`);
}

const scriptName = `package:${packageKind}:${getTarget()}`;
console.log(`Running npm run ${scriptName}`);

const result = spawnSync("npm", ["run", scriptName], {
    stdio: "inherit",
    shell: process.platform === "win32",
});

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);
