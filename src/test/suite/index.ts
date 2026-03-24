import * as fs from 'fs';
import * as path from 'path';
import * as Mocha from 'mocha';

function collectTestFiles(root: string): string[] {
    const discovered: string[] = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop()!;
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith('.test.js')) {
                discovered.push(fullPath);
            }
        }
    }

    discovered.sort();
    return discovered;
}

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 30_000,
    });

    const testsRoot = path.resolve(__dirname);
    const files = collectTestFiles(testsRoot);

    if (files.length === 0) {
        return Promise.reject(new Error('No extension test files were found.'));
    }

    for (const file of files) {
        mocha.addFile(file);
    }

    return new Promise((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} tests failed.`));
                return;
            }

            resolve();
        });
    });
}
