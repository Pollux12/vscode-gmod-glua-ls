import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const fixtureWorkspacePath = path.resolve(__dirname, '../../test-fixtures/workspace');
    const settingsPath = path.join(fixtureWorkspacePath, '.vscode/settings.json');
    const settings = fs.readFileSync(settingsPath);
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../..');
        const e2e = process.argv.includes('--e2e');
        const extensionTestsPath = path.resolve(__dirname, e2e ? './e2e/index' : './suite/index');

        await runTests({
            version: process.env.VSCODE_TEST_VERSION,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [fixtureWorkspacePath, '--disable-extensions',
                ...(e2e ? ['--user-data-dir', path.resolve(extensionDevelopmentPath,
                    `.vscode-test/e2e-user-data-${process.env.VSCODE_TEST_VERSION || 'stable'}`)] : []),
            ],
        });
    } catch (error) {
        console.error(error);
        console.error('Failed to run extension tests');
        process.exitCode = 1;
    } finally {
        fs.writeFileSync(settingsPath, settings);
    }
}

void main();
