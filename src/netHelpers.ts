import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import fetch from 'node-fetch';
import AdmZip = require('adm-zip');

/**
 * Common network operations options
 */
export interface FetchOptions {
    timeoutMs?: number;
    headers?: Record<string, string>;
}

/**
 * Request JSON from a given URL
 */
export async function fetchJson<T>(url: string, options?: FetchOptions): Promise<T> {
    const response = await fetch(url, {
        timeout: options?.timeoutMs ?? 10000,
        headers: {
            'User-Agent': 'vscode-gmod-glua-ls',
            ...options?.headers,
        },
    });

    if (!response.ok) {
        response.body?.resume();
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
    const response = await fetch(url, {
        timeout: options?.timeoutMs ?? 30000,
        headers: { 'User-Agent': 'vscode-gmod-glua-ls', ...options?.headers },
    });

    if (!response.ok || !response.body) {
        response.body?.resume();
        throw new Error(`HTTP ${response.status} ${response.statusText} when downloading ${url}`);
    }

    const totalBytesStr = response.headers.get('content-length');
    const totalBytes = totalBytesStr ? parseInt(totalBytesStr, 10) : 0;

    let downloadedBytes = 0;
    let lastReportedPercentage = 0;
    let lastReportedMb = -1;

    await new Promise<void>((resolve, reject) => {
        const fileStream = fs.createWriteStream(destinationPath);
        let errorHandled = false;

        const handleError = (err: Error) => {
            if (errorHandled) return;
            errorHandled = true;
            fileStream.close(() => {
                fs.unlink(destinationPath, () => {
                    reject(err);
                });
            });
        };

        response.body.on('error', handleError);
        fileStream.on('error', handleError);

        fileStream.once('close', () => {
            if (!errorHandled) {
                resolve();
            }
        });

        response.body.on('data', (chunk: Buffer) => {
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

        response.body.pipe(fileStream);
    });
}

/**
 * Downloads a zip file to memory/temp and extracts a specific root folder's contents into the destination.
 */
export async function downloadAndExtractZip(
    url: string,
    destinationPath: string,
    innerFolderName: string,
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

        const extractedFolderPath = path.join(tempDir, innerFolderName);
        if (!fs.existsSync(extractedFolderPath)) {
            throw new Error(`Expected folder '${innerFolderName}' not found in the downloaded zip.`);
        }

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
