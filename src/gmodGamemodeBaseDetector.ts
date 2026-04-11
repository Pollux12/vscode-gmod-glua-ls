import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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

    // Look for <foldername>.txt in the workspace root
    const txtFileName = `${folderName}.txt`;
    const txtFilePath = path.join(folderPath, txtFileName);

    const libraries: string[] = [];
    const visited = new Set<string>([folderName.toLowerCase()]);

    let currentBase = await readGamemodeBase(txtFilePath);

    while (currentBase) {
        const baseLower = currentBase.toLowerCase();

        // Prevent cycles
        if (visited.has(baseLower)) {
            break;
        }
        visited.add(baseLower);

        // The base gamemode folder is a sibling of the current gamemode folder
        // Gamemodes are stored as: gamemodes/<gamemode_name>/
        // So the base would be at: ../<base_name>
        const relativePath = `../${baseLower}`;
        libraries.push(relativePath);

        // Try to walk the chain further
        const baseTxtPath = path.join(folderPath, '..', baseLower, `${baseLower}.txt`);
        currentBase = await readGamemodeBase(baseTxtPath);
    }

    return libraries;
}

/**
 * Reads a gamemode `.txt` file and extracts the `"base"` field.
 * Returns `undefined` if the file doesn't exist, can't be read,
 * isn't valid KeyValues format, or has no/empty `"base"` field.
 * Never throws — all errors are silently caught.
 */
async function readGamemodeBase(txtFilePath: string): Promise<string | undefined> {
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

        // Tokenize: extract all quoted strings
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
