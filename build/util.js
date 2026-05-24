import { join } from "path";
import { readFileSync, writeFileSync, createWriteStream } from "fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function downloadTo(url, path) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} ${response.statusText} when downloading ${url}`
        );
    }
    if (!response.body) {
        throw new Error(`No response body when downloading ${url}`);
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

export function ensureNl(s) {
    if (!s.endsWith("\n")) {
        s += "\n";
    }
    return s;
}

export function readJson(path) {
    return JSON.parse(readFileSync(path));
}

export function writeJson(path, data) {
    writeFileSync(path, ensureNl(JSON.stringify(data, null, 4)));
}

export const schemaPath = join(__dirname, "..", "syntaxes", "schema.json");
export const readSchema = () => readJson(schemaPath);
export const writeSchema = (data) => writeJson(schemaPath, data);

export const schemaPathI18n = join(
    __dirname,
    "..",
    "syntaxes",
    "schema.i18n.json"
);
export const readSchemaI18n = () => readJson(schemaPathI18n);
export const writeSchemaI18n = (data) => writeJson(schemaPathI18n, data);

export const localePathDefault = join(__dirname, "..", "package.nls.json");
export const readLocaleDefault = () => readJson(localePathDefault);
export const writeLocaleDefault = (data) => writeJson(localePathDefault, data);

export const localePathZhCn = join(__dirname, "..", "package.nls.zh-cn.json");
export const readLocaleZhCn = () => readJson(localePathZhCn);
export const writeLocaleZhCn = (data) => writeJson(localePathZhCn, data);

export const packagePath = join(__dirname, "..", "package.json");
export const readPackage = () => readJson(packagePath);
export const writePackage = (data) => writeJson(packagePath, data);

export const configPath = join(__dirname, "config.json");
export const readConfig = () => readJson(configPath);
export const writeConfig = (data) => writeJson(configPath, data);
