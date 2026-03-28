import AdmZip from "adm-zip";

const [vsixPath, target] = process.argv.slice(2);

if (!vsixPath || !target) {
    console.error("Usage: node ./build/verify-vsix.js <vsix-path> <target>");
    process.exit(1);
}

const expectedEntry =
    target === "win32-x64"
        ? "extension/server/glua_ls.exe"
        : "extension/server/glua_ls";

const zip = new AdmZip(vsixPath);
const entry = zip.getEntry(expectedEntry);

if (!entry) {
    const serverEntries = zip
        .getEntries()
        .map((zipEntry) => zipEntry.entryName)
        .filter((entryName) => entryName.startsWith("extension/server/"));

    console.error(
        `Missing bundled language server '${expectedEntry}' in ${vsixPath}. Found server entries: ${serverEntries.join(", ") || "<none>"}`
    );
    process.exit(1);
}

if (entry.header.size <= 0) {
    console.error(
        `Bundled language server '${expectedEntry}' in ${vsixPath} is empty.`
    );
    process.exit(1);
}

console.log(
    `Verified bundled language server '${expectedEntry}' in ${vsixPath} (${entry.header.size} bytes).`
);
