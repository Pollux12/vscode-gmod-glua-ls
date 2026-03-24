import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../..');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        const fixtureWorkspacePath = path.resolve(__dirname, '../../test-fixtures/workspace');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [fixtureWorkspacePath, '--disable-extensions'],
        });
    } catch (error) {
        console.error(error);
        console.error('Failed to run extension tests');
        process.exit(1);
    }
}

void main();
