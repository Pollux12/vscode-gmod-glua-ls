import { copyFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import decompress from "decompress";
import decompressTarGz from "decompress-targz";
import config from "./config.json" with { type: "json" };
import { downloadTo } from "./util.js";

const args = process.argv;
const languageServerAssetName = args[2];

function getArgValue(flagName) {
    const flagIndex = args.indexOf(flagName);
    if (flagIndex === -1 || flagIndex + 1 >= args.length) {
        return undefined;
    }

    return args[flagIndex + 1];
}

function hasFlag(flagName) {
    return args.includes(flagName);
}

function getLanguageServerExecutableName(assetName) {
    return assetName.includes("win32") ? "emmylua_ls.exe" : "emmylua_ls";
}

function resolveLocalLanguageServerSource(assetName) {
    const executableName = getLanguageServerExecutableName(assetName);
    const cliLocalPath = getArgValue("--local-ls");
    const envLocalPath = process.env.EMMY_LOCAL_LS_PATH?.trim();

    const candidates = [
        cliLocalPath,
        envLocalPath,
        `../emmylua-analyzer-rust/target/release/${executableName}`,
        `../emmylua-analyzer-rust/target/debug/${executableName}`,
    ]
        .filter(Boolean)
        .map(path => resolve(path));

    return candidates.find(path => existsSync(path));
}


async function resolveLanguageServerSource(assetName) {
    const forceRemoteLanguageServer = hasFlag("--remote-ls");
    if (!forceRemoteLanguageServer) {
        const localSource = resolveLocalLanguageServerSource(assetName);
        if (localSource) {
            console.log(`Using local language server source: ${localSource}`);
            return localSource;
        }
    }

    const downloadPath = `temp/${assetName}`;
    console.log(`Downloading language server from ${config.newLanguageServerUrl}/${config.newLanguageServerVersion}/${assetName}`);
    await downloadTo(
        `${config.newLanguageServerUrl}/${config.newLanguageServerVersion}/${assetName}`,
        downloadPath
    );

    return downloadPath;
}

async function installLanguageServerFromSource(sourcePath, assetName) {
    if (sourcePath.endsWith(".tar.gz")) {
        await decompress(sourcePath, `server/`, {
            plugins: [decompressTarGz()],
        });
        return;
    }

    if (sourcePath.endsWith(".zip")) {
        await decompress(sourcePath, `server/`);
        return;
    }

    const executableName = getLanguageServerExecutableName(assetName);
    const destinationPath = `server/${executableName}`;
    copyFileSync(sourcePath, destinationPath);
}

async function build() {
    if (!languageServerAssetName) {
        throw new Error("Missing language server asset name. Example: node ./build/prepare.js emmylua_ls-win32-x64.zip");
    }

    if (!existsSync("temp")) {
        mkdirSync("temp");
    }
    if (!existsSync("server")) {
        mkdirSync("server");
    }

    const languageServerSource = await resolveLanguageServerSource(languageServerAssetName);

    await installLanguageServerFromSource(languageServerSource, languageServerAssetName);
}

build().catch(console.error);
