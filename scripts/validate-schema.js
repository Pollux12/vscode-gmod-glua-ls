#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Smoke test: verify that schema JSON files are parseable.
 *
 * Run via: npm run test:schema
 * Also runs as part of: npm run test:all
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const FILES_TO_VALIDATE = [
    { path: path.join(ROOT, "syntaxes", "schema.json"), required: true },
    { path: path.join(ROOT, "syntaxes", "schema.i18n.json"), required: true },
];

let allPassed = true;

for (const item of FILES_TO_VALIDATE) {
    const relative = path.relative(ROOT, item.path);

    if (!fs.existsSync(item.path)) {
        console.error(`  FAIL  ${relative}: file not found`);
        allPassed = false;
        continue;
    }

    try {
        const raw = fs.readFileSync(item.path, "utf8");
        JSON.parse(raw);
        console.log(`  ok  ${relative}`);
    } catch (/** @type {any} */ err) {
        console.error(`  FAIL  ${relative}: ${err.message}`);
        allPassed = false;
    }
}

if (!allPassed) {
    process.exit(1);
}

console.log(`\nAll ${FILES_TO_VALIDATE.length} schema files are valid JSON.`);
