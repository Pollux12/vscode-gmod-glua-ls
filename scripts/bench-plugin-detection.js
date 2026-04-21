#!/usr/bin/env node

/*
 * Synthetic workspace generator for plugin-detection benchmarking.
 *
 * Usage:
 *   node scripts/bench-plugin-detection.js --files 5000 --cami-ratio 0.02
 *
 * It creates a temporary workspace folder with many Lua files and prints
 * follow-up steps to benchmark detection inside the VS Code extension host.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
    const args = {
        files: 5000,
        camiRatio: 0.02,
        output: undefined,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i];
        if (current === '--files' && argv[i + 1]) {
            args.files = Math.max(1, Number.parseInt(argv[i + 1], 10) || args.files);
            i += 1;
        } else if (current === '--cami-ratio' && argv[i + 1]) {
            const parsed = Number.parseFloat(argv[i + 1]);
            args.camiRatio = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : args.camiRatio;
            i += 1;
        } else if (current === '--output' && argv[i + 1]) {
            args.output = path.resolve(argv[i + 1]);
            i += 1;
        }
    }

    return args;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function createWorkspaceDir(outputPath) {
    if (outputPath) {
        ensureDir(outputPath);
        return outputPath;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return fs.mkdtempSync(path.join(os.tmpdir(), `gluals-plugin-bench-${stamp}-`));
}

function writeManifest(workspacePath) {
    const manifestPath = path.join(workspacePath, 'gamemode.txt');
    fs.writeFileSync(
        manifestPath,
        '"bench"\n{\n  "base" "sandbox"\n}\n',
        'utf8',
    );
}

function writeLuaFiles(workspacePath, files, camiRatio) {
    const baseLuaDir = path.join(workspacePath, 'lua');
    const dirs = [
        path.join(baseLuaDir, 'autorun', 'server'),
        path.join(baseLuaDir, 'autorun', 'client'),
        path.join(workspacePath, 'addons', 'bench_addon', 'lua', 'entities'),
        path.join(workspacePath, 'gamemodes', 'bench_gamemode', 'gamemode'),
    ];
    for (const dir of dirs) {
        ensureDir(dir);
    }

    const camiEvery = Math.max(1, Math.floor(1 / Math.max(0.0001, camiRatio)));

    for (let i = 0; i < files; i += 1) {
        const dir = dirs[i % dirs.length];
        const filePath = path.join(dir, `bench_${String(i).padStart(6, '0')}.lua`);
        const hasCamiSignal = i % camiEvery === 0;
        const content = hasCamiSignal
            ? 'local value = 1\nif CAMI then\n    CAMI.RegisterPrivilege({ Name = "bench" })\nend\n'
            : 'local value = 1\nlocal text = "benchmark"\nreturn value\n';
        fs.writeFileSync(filePath, content, 'utf8');
    }
}

function main() {
    const { files, camiRatio, output } = parseArgs(process.argv.slice(2));
    const workspacePath = createWorkspaceDir(output);

    writeManifest(workspacePath);
    writeLuaFiles(workspacePath, files, camiRatio);

    const relHint = path.relative(process.cwd(), workspacePath) || workspacePath;
    console.log('Synthetic plugin-detection benchmark workspace generated.');
    console.log(`Workspace: ${workspacePath}`);
    console.log(`Lua files: ${files}`);
    console.log(`CAMI signal ratio: ${camiRatio}`);
    console.log('');
    console.log('Manual benchmark steps:');
    console.log(`1. Open workspace: code "${workspacePath}"`);
    console.log('2. In the opened VS Code window, run command: GLuaLS: Rerun Framework Detection');
    console.log('3. Inspect output channel: GLuaLS · Plugin Detection');
    console.log('4. Repeat step 2 to compare cold vs warm (cache-hit) timings.');
    console.log('');
    console.log(`Relative path hint: ${relHint}`);
}

main();
