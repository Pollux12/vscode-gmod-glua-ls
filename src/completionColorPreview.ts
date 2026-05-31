import * as vscode from 'vscode';

export function enableCompletionColorPreviewHtml(item: vscode.CompletionItem): vscode.CompletionItem {
    const color = getCompletionColorData(item);
    if (!color) {
        return item;
    }

    item.detail = color.hex;
    return item;
}

export function enableCompletionColorPreviewHtmlForResult<T extends vscode.CompletionList | vscode.CompletionItem[] | undefined | null>(
    result: T
): T {
    if (!result) {
        return result;
    }

    const items = Array.isArray(result) ? result : result.items;
    for (const item of items) {
        enableCompletionColorPreviewHtml(item);
    }

    return result;
}

type CompletionItemWithData = vscode.CompletionItem & {
    data?: unknown;
};

type CompletionColorData = {
    red: number;
    green: number;
    blue: number;
    alpha: number;
    hex: string;
};

function getCompletionColorData(item: vscode.CompletionItem): CompletionColorData | undefined {
    if (item.kind !== vscode.CompletionItemKind.Color) {
        return undefined;
    }

    const data = (item as CompletionItemWithData).data;
    if (!isRecord(data) || !isRecord(data.color)) {
        return undefined;
    }

    const color = data.color;
    if (
        !isByte(color.red) ||
        !isByte(color.green) ||
        !isByte(color.blue) ||
        !isByte(color.alpha) ||
        typeof color.hex !== 'string' ||
        !/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color.hex)
    ) {
        return undefined;
    }

    return {
        red: color.red,
        green: color.green,
        blue: color.blue,
        alpha: color.alpha,
        hex: color.hex.toUpperCase(),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isByte(value: unknown): value is number {
    return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 255;
}
