#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function normalizeSeverity(value) {
    if (typeof value === "number") {
        if (value === 1) return "error";
        if (value === 2) return "warning";
        if (value === 3) return "info";
        if (value === 4) return "hint";
    }
    const text = String(value || "").toLowerCase();
    if (text.includes("error")) return "error";
    if (text.includes("warn")) return "warning";
    if (text.includes("hint")) return "hint";
    return "info";
}

function asDiagnosticsFromJson(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.diagnostics)) return payload.diagnostics;
    if (payload && Array.isArray(payload.items)) return payload.items;
    return [];
}

function parseTextDiagnostics(raw) {
    const entries = [];
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const severityMatch = trimmed.match(/\b(error|warning|warn|info|hint)\b/i);
        const codeMatch = trimmed.match(/\b([a-z]+-[a-z0-9-]+)\b/i);
        const fileMatch = trimmed.match(/([A-Za-z]:\\[^:\]]+\.lua|[^:\s]+\.lua)/i);
        entries.push({
            severity: normalizeSeverity(severityMatch ? severityMatch[1] : "info"),
            code: codeMatch ? codeMatch[1] : "unknown",
            file: fileMatch ? fileMatch[1].replace(/\\/g, "/") : "unknown",
        });
    }
    return entries;
}

function toEntry(item) {
    return {
        severity: normalizeSeverity(item.severity),
        code: typeof item.code === "string" && item.code.length > 0
            ? item.code
            : (item.code && item.code.value) || "unknown",
        file:
            (typeof item.file === "string" && item.file) ||
            (item.uri && typeof item.uri === "string" ? item.uri : "") ||
            "unknown",
    };
}

function keyFor(entry) {
    return `${entry.severity}|${entry.code}|${entry.file}`;
}

function summarize(entries) {
    const grouped = new Map();
    for (const entry of entries) {
        const normalized = {
            severity: entry.severity,
            code: entry.code || "unknown",
            file: String(entry.file || "unknown").replace(/\\/g, "/"),
        };
        const key = keyFor(normalized);
        grouped.set(key, (grouped.get(key) || 0) + 1);
    }

    const rows = [...grouped.entries()].map(([key, count]) => {
        const [severity, code, file] = key.split("|");
        return { severity, code, file, count };
    });
    rows.sort((a, b) =>
        a.severity.localeCompare(b.severity) ||
        a.code.localeCompare(b.code) ||
        a.file.localeCompare(b.file),
    );
    return rows;
}

function main() {
    const inputArg = process.argv[2] || path.resolve(process.cwd(), "darkrpdiagnostic.txt");
    const inputPath = path.resolve(process.cwd(), inputArg);
    const raw = fs.readFileSync(inputPath, "utf8");

    let diagnostics = [];
    try {
        const parsed = JSON.parse(raw);
        diagnostics = asDiagnosticsFromJson(parsed).map(toEntry);
    } catch {
        diagnostics = parseTextDiagnostics(raw);
    }

    const summary = summarize(diagnostics);
    const output = {
        source: inputPath,
        total: diagnostics.length,
        groups: summary,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
