import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { resolve } from "path";
import decompress from "decompress";
import decompressTarGz from "decompress-targz";
import config from "./config.json" with { type: "json" };
import { downloadTo } from "./util.js";

const args = process.argv;
const languageServerAssetName = args[2];
const RELEASE_CHANNELS = new Set(["stable", "prerelease"]);

const GITHUB_RELEASES_API =
    "https://api.github.com/repos/Pollux12/gmod-glua-ls/releases?per_page=100";
const GITHUB_RELEASE_BY_TAG_API =
    "https://api.github.com/repos/Pollux12/gmod-glua-ls/releases/tags";
const BASE_GITHUB_API_HEADERS = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vscode-gmod-glua-ls-build",
};

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

function getGitHubToken() {
    const envToken = process.env.GITHUB_TOKEN?.trim();
    return envToken || undefined;
}

function getGitHubApiHeaders() {
    const token = getGitHubToken();
    if (!token) {
        console.warn(
            "Warning: No GitHub token provided for GitHub API requests. Proceeding unauthenticated and may hit rate limits."
        );
        return BASE_GITHUB_API_HEADERS;
    }

    return {
        ...BASE_GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
    };
}

function getReleaseChannel() {
    const channel = getArgValue("--channel") ?? "stable";
    if (!RELEASE_CHANNELS.has(channel)) {
        throw new Error(
            `Invalid --channel '${channel}'. Expected one of: stable, prerelease`
        );
    }
    return channel;
}

function getLanguageServerVersionOverride() {
    return getArgValue("--ls-version")?.trim();
}

function getLanguageServerExecutableName(assetName) {
    return assetName.includes("win32") ? "glua_ls.exe" : "glua_ls";
}

function resolveLocalLanguageServerSource(assetName) {
    const executableName = getLanguageServerExecutableName(assetName);
    const cliLocalPath = getArgValue("--local-ls");
    const envLocalPath = process.env.EMMY_LOCAL_LS_PATH?.trim();

    const candidates = [
        cliLocalPath,
        envLocalPath,
        `../gmod-glua-ls/target/release/${executableName}`,
        `../gmod-glua-ls/target/debug/${executableName}`,
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
    const languageServerVersionOverride = getLanguageServerVersionOverride();

    if (languageServerVersionOverride) {
        const releaseAssetUrl = await resolveReleaseAssetUrlByTag(
            languageServerVersionOverride,
            assetName
        );
        console.log(
            `Downloading language server ${languageServerVersionOverride} from ${releaseAssetUrl}`
        );
        await downloadTo(releaseAssetUrl, downloadPath);
        return downloadPath;
    }

    if (getReleaseChannel() === "prerelease") {
        try {
            const prereleaseAssetUrl = await resolveLatestPreReleaseAssetUrl(assetName);
            console.log(`Downloading pre-release language server from ${prereleaseAssetUrl}`);
            await downloadTo(prereleaseAssetUrl, downloadPath);
            return downloadPath;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(
                `ERROR: --channel prerelease was specified but no pre-release of gmod-glua-ls was found. Cannot build pre-release extension. (${errorMessage})`
            );
        }
    }

    console.log(`Downloading language server from ${config.newLanguageServerUrl}/${config.newLanguageServerVersion}/${assetName}`);
    await downloadTo(
        `${config.newLanguageServerUrl}/${config.newLanguageServerVersion}/${assetName}`,
        downloadPath
    );

    return downloadPath;
}

function getTagCandidates(versionOrTag) {
    const value = versionOrTag.trim();
    if (!value) {
        return [];
    }

    if (value.startsWith("v")) {
        return [value, value.slice(1)].filter(Boolean);
    }

    return [value, `v${value}`];
}

async function resolveReleaseAssetUrlByTag(versionOrTag, assetName) {
    let lastError;
    for (const tagCandidate of getTagCandidates(versionOrTag)) {
        try {
            const release = await fetchReleaseByTag(tagCandidate);
            const asset = release.assets?.find(
                (entry) =>
                    entry?.name === assetName &&
                    typeof entry.browser_download_url === "string"
            );

            if (!asset) {
                throw new Error(
                    `Release ${release.tag_name} does not include asset ${assetName}`
                );
            }

            console.log(`Using language server release ${release.tag_name}`);
            return asset.browser_download_url;
        } catch (error) {
            lastError = error;
        }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
        `Unable to resolve language server release '${versionOrTag}' for asset ${assetName} (${errorMessage})`
    );
}

async function fetchReleaseByTag(tagName) {
    const response = await fetch(
        `${GITHUB_RELEASE_BY_TAG_API}/${encodeURIComponent(tagName)}`,
        { headers: getGitHubApiHeaders() }
    );

    if (!response.ok) {
        throw new Error(`GitHub release lookup for ${tagName} returned ${response.status} ${response.statusText}`);
    }

    return response.json();
}

async function resolveLatestPreReleaseAssetUrl(assetName) {
    const response = await fetch(GITHUB_RELEASES_API, {
        headers: getGitHubApiHeaders(),
    });

    if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status} ${response.statusText}`);
    }

    const releases = await response.json();
    if (!Array.isArray(releases)) {
        throw new Error("GitHub API response was not an array of releases");
    }

    const preRelease = releases.find((release) => {
        return release?.prerelease === true && Array.isArray(release.assets);
    });

    if (!preRelease) {
        throw new Error("No pre-release found in gmod-glua-ls releases list");
    }

    const asset = preRelease.assets.find(
        (entry) => entry?.name === assetName && typeof entry.browser_download_url === "string"
    );

    if (!asset) {
        throw new Error(
            `Pre-release ${preRelease.tag_name} does not include asset ${assetName}`
        );
    }

    console.log(`Using pre-release language server ${preRelease.tag_name}`);
    return asset.browser_download_url;
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
        throw new Error("Missing language server asset name. Example: node ./build/prepare.js glua_ls-win32-x64.zip");
    }

    const channel = getReleaseChannel();
    console.log(`Using release channel: ${channel}`);

    if (!existsSync("temp")) {
        mkdirSync("temp");
    }
    if (!existsSync("server")) {
        mkdirSync("server");
    }

    // Ensure we only ship the target language server binary for this package.
    for (const entry of readdirSync("server")) {
        rmSync(resolve("server", entry), { recursive: true, force: true });
    }

    const languageServerSource = await resolveLanguageServerSource(languageServerAssetName);

    await installLanguageServerFromSource(languageServerSource, languageServerAssetName);
}

build().catch(console.error);
