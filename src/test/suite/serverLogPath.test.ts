import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    SERVER_LOG_PATH_ARGUMENT,
    getServerLogDirectory,
    withServerLogPathArgument,
} from '../../serverLogPath';

suite('Server Log Path', () => {
    test('uses VS Code extension log directory for language server logs', () => {
        const extensionLogPath = path.join(
            vscode.workspace.workspaceFolders![0].uri.fsPath,
            '.logs',
            'session',
            'window1',
            'exthost',
            'Pollux.gmod-glua-ls'
        );
        const context = {
            logUri: vscode.Uri.file(extensionLogPath),
        } as vscode.ExtensionContext;

        const logDirectory = getServerLogDirectory(context);

        assert.strictEqual(
            logDirectory.fsPath,
            path.join(extensionLogPath, 'server')
        );
    });

    test('appends server log path unless user already configured one', () => {
        const logDirectory = vscode.Uri.file('C:\\logs\\gluals');

        assert.deepStrictEqual(
            withServerLogPathArgument(['--stdio'], logDirectory),
            ['--stdio', SERVER_LOG_PATH_ARGUMENT, 'c:\\logs\\gluals']
        );

        assert.deepStrictEqual(
            withServerLogPathArgument(['--log-path', 'C:\\custom'], logDirectory),
            ['--log-path', 'C:\\custom']
        );

        assert.deepStrictEqual(
            withServerLogPathArgument(['--log-path=C:\\custom'], logDirectory),
            ['--log-path=C:\\custom']
        );
    });
});
