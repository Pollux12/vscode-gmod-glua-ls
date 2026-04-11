import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const BUILTIN_GAMEMODE_BASES = new Set(['sandbox', 'base']);

/**
 * Detects gamemode base dependencies by reading the gamemode `.txt` file
 * and following the `"base"` chain. Returns an array of relative library paths
 * that should be added to the workspace configuration.
 *
 * The KeyValues parser is deliberately tolerant: if the file cannot be parsed
 * (malformed, not KeyValues format, binary, etc.), detection silently returns
 * an empty result — no errors are thrown or shown to the user.
 */
export async function detectGamemodeBaseLibraries(
    workspaceFolder: vscode.WorkspaceFolder
): Promise<string[]> {
    const folderPath = workspaceFolder.uri.fsPath;
    const folderName = path.basename(folderPath);

    const libraries: string[] = [];
    const visited = new Set<string>([folderName.toLowerCase()]);

    let currentBase = await readGamemodeBaseFromFolder(folderPath, folderName);

    while (currentBase) {
        const baseLower = currentBase.toLowerCase();

        // Prevent cycles
        if (visited.has(baseLower)) {
            break;
        }
        visited.add(baseLower);

        // Built-in gamemodes already have curated annotation metadata, so
        // loading their source folders as libraries creates duplicate hook and
        // member entries with noisier hover/completion output.
        if (BUILTIN_GAMEMODE_BASES.has(baseLower)) {
            break;
        }

        // The base gamemode folder is a sibling of the current gamemode folder
        // Gamemodes are stored as: gamemodes/<gamemode_name>/
        // So the base would be at: ../<base_name>
        const relativePath = `../${baseLower}`;
        libraries.push(relativePath);

        // Try to walk the chain further
        const baseFolderPath = path.join(folderPath, '..', baseLower);
        currentBase = await readGamemodeBaseFromFolder(baseFolderPath, baseLower);
    }

    return libraries;
}

async function readGamemodeBaseFromFolder(
    folderPath: string,
    folderName: string
): Promise<string | undefined> {
    const txtFilePath = findGamemodeManifestPath(folderPath, folderName);
    if (!txtFilePath) {
        return undefined;
    }

    return readGamemodeBase(txtFilePath);
}

function findGamemodeManifestPath(folderPath: string, folderName: string): string | undefined {
    const preferredPath = path.join(folderPath, `${folderName}.txt`);
    if (fs.existsSync(preferredPath)) {
        return preferredPath;
    }

    try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        const candidates = entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
            .map((entry) => path.join(folderPath, entry.name))
            .sort((left, right) => left.localeCompare(right));

        for (const candidatePath of candidates) {
            if (readGamemodeBaseSync(candidatePath) !== undefined) {
                return candidatePath;
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

/**
 * Reads a gamemode `.txt` file and extracts the `"base"` field.
 * Returns `undefined` if the file doesn't exist, can't be read,
 * isn't valid KeyValues format, or has no/empty `"base"` field.
 * Never throws — all errors are silently caught.
 */
async function readGamemodeBase(txtFilePath: string): Promise<string | undefined> {
    return readGamemodeBaseSync(txtFilePath);
}

function readGamemodeBaseSync(txtFilePath: string): string | undefined {
    try {
        const content = fs.readFileSync(txtFilePath, 'utf-8').trim();
        if (!content) {
            return undefined;
        }

        const baseValue = parseKeyValuesBase(content);
        if (!baseValue || baseValue.trim().length === 0) {
            return undefined;
        }

        return baseValue.trim();
    } catch {
        // File doesn't exist, can't be read, or isn't valid — silently skip
        return undefined;
    }
}

/**
 * Tolerant KeyValues parser that only extracts the `"base"` value from
 * the top-level section. Returns `undefined` if parsing fails at any point.
 *
 * Expected format:
 * ```
 * "GamemodeName"
 * {
 *     "base"      "Sandbox"
 *     "title"     "My Gamemode"
 *     ...
 * }
 * ```
 *
 * The parser is intentionally forgiving:
 * - Handles both `\t` and spaces as whitespace
 * - Handles CRLF and LF line endings
 * - Ignores comments (// style)
 * - If the structure doesn't look like KeyValues, returns undefined
 */
function parseKeyValuesBase(content: string): string | undefined {
    try {
        // Remove comments (// to end of line)
        const lines = content.split(/\r?\n/).map(line => {
            const commentIdx = line.indexOf('//');
            if (commentIdx >= 0) {
                return line.substring(0, commentIdx);
            }
            return line;
        });

        // Tokenize quoted strings plus top-level structure markers.
        const tokens: string[] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            // Extract quoted strings from this line
            let i = 0;
            while (i < trimmed.length) {
                if (trimmed[i] === '"') {
                    // Find closing quote
                    const start = i + 1;
                    let end = start;
                    while (end < trimmed.length && trimmed[end] !== '"') {
                        // Skip escaped quotes
                        if (trimmed[end] === '\\' && end + 1 < trimmed.length) {
                            end += 2;
                        } else {
                            end++;
                        }
                    }

                    if (end < trimmed.length) {
                        const token = trimmed.substring(start, end);
                        tokens.push(token);
                        i = end + 1;
                    } else {
                        // Unclosed quote — malformed, but we'll be tolerant
                        // and just take what we can get
                        const token = trimmed.substring(start);
                        if (token.length > 0) {
                            tokens.push(token);
                        }
                        break;
                    }
                } else if (trimmed[i] === '{' || trimmed[i] === '}') {
                    tokens.push(trimmed[i]);
                    i++;
                } else {
                    i++;
                }
            }
        }

        if (tokens.length < 2) {
            return undefined;
        }

        // The first token is the section name (e.g., "CityRP")
        // Then we expect key-value pairs inside the section
        // Look for the "base" key in the top-level section
        // After the section name, the next token should be "{"
        // Then key-value pairs, then "}"
        // But we'll be tolerant and just scan for "base" as a key

        let inTopSection = false;
        let braceDepth = 0;

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            if (token === '{') {
                braceDepth++;
                if (braceDepth === 1) {
                    inTopSection = true;
                }
                continue;
            }

            if (token === '}') {
                braceDepth--;
                if (braceDepth === 0) {
                    inTopSection = false;
                }
                continue;
            }

            // Only look for "base" in the top-level section (depth 1)
            if (inTopSection && braceDepth === 1 && token.toLowerCase() === 'base') {
                // The next token should be the value
                if (i + 1 < tokens.length) {
                    const value = tokens[i + 1];
                    // Make sure the value isn't a brace
                    if (value !== '{' && value !== '}') {
                        return value;
                    }
                }
            }
        }

        return undefined;
    } catch {
        // Any parsing error — silently return undefined
        return undefined;
    }
}
