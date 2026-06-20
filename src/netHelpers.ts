import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as vscode from 'vscode';
import AdmZip = require('adm-zip');

/**
 * Common network operations options
 */
export interface FetchOptions {
    timeoutMs?: number;
    headers?: Record<string, string>;
}

async function fetchWithTimeout(url: string, options: FetchOptions | undefined, defaultTimeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? defaultTimeoutMs);

    try {
        return await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'vscode-gmod-glua-ls',
                ...options?.headers,
            },
        });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Request JSON from a given URL
 */
export async function fetchJson<T>(url: string, options?: FetchOptions): Promise<T> {
    const response = await fetchWithTimeout(url, options, 10000);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} when fetching ${url}`);
    }

    return response.json() as Promise<T>;
}

/**
 * Downloads a file to a destination, reporting progress if provided.
 */
export async function downloadFile(
    url: string,
    destinationPath: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    options?: FetchOptions
): Promise<void> {
    const response = await fetchWithTimeout(url, options, 30000);

    if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText} when downloading ${url}`);
    }

    const totalBytesStr = response.headers.get('content-length');
    const totalBytes = totalBytesStr ? parseInt(totalBytesStr, 10) : 0;

    let downloadedBytes = 0;
    let lastReportedPercentage = 0;
    let lastReportedMb = -1;

    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk: Buffer) => {
        if (progress) {
            downloadedBytes += chunk.length;

            if (totalBytes > 0) {
                const percentage = Math.floor((downloadedBytes / totalBytes) * 100);
                if (percentage > lastReportedPercentage) {
                    const increment = percentage - lastReportedPercentage;
                    progress.report({
                        message: `Downloading... ${percentage}%`,
                        increment,
                    });
                    lastReportedPercentage = percentage;
                }
            } else {
                // Indeterminate progress (no Content-Length header, e.g. GitHub archives)
                const currentMbStr = (downloadedBytes / (1024 * 1024)).toFixed(1);
                const currentMbNum = Math.floor(downloadedBytes / (1024 * 1024));

                if (currentMbNum > lastReportedMb || lastReportedMb === -1) {
                    progress.report({
                        message: `Downloading... ${currentMbStr} MB`,
                    });
                    lastReportedMb = currentMbNum;
                }
            }
        }
    });

    try {
        const fileStream = fs.createWriteStream(destinationPath);
        await pipeline(body, fileStream);
    } catch (error) {
        fs.unlink(destinationPath, () => undefined);
        throw error;
    }
}

/**
 * Downloads a zip file to memory/temp and extracts the archive's single top-level directory into the destination.
 */
export async function downloadAndExtractZip(
    url: string,
    destinationPath: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gluals-zip-dl-'));
    const tempZipPath = path.join(tempDir, 'download.zip');

    try {
        if (progress) {
            progress.report({ message: 'Downloading zip archive...', increment: 0 });
        }

        await downloadFile(url, tempZipPath, progress);

        if (progress) {
            progress.report({ message: 'Extracting files...', increment: 0 });
        }

        const zip = new AdmZip(tempZipPath);
        const resolvedTempDir = path.resolve(tempDir);
        for (const entry of zip.getEntries()) {
            const entryDest = path.resolve(resolvedTempDir, entry.entryName);
            if (!entryDest.startsWith(resolvedTempDir + path.sep) && entryDest !== resolvedTempDir) {
                throw new Error(`Zip entry path traversal rejected: ${entry.entryName}`);
            }
        }
        zip.extractAllTo(tempDir, true);

        const extractedEntries = fs.readdirSync(tempDir, { withFileTypes: true })
            .filter((entry) => entry.name !== 'download.zip');
        const topLevelDirectories = extractedEntries.filter((entry) => entry.isDirectory());
        if (topLevelDirectories.length !== 1 || extractedEntries.length !== 1) {
            throw new Error('Expected the downloaded zip to contain a single top-level directory.');
        }
        const extractedFolderPath = path.join(tempDir, topLevelDirectories[0].name);

        // Clean target directory if exists
        if (fs.existsSync(destinationPath)) {
            fs.rmSync(destinationPath, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

        // Copy over from temp
        fs.cpSync(extractedFolderPath, destinationPath, { recursive: true });

    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
