import * as vscode from 'vscode';

export function enableCompletionColorPreviewHtml(item: vscode.CompletionItem): vscode.CompletionItem {
    const color = getCompletionColorData(item);
    if (!color) {
        return item;
    }

    item.detail = toParseableColor(color);
    return item;
}

// VS Code only previews colours whose detail matches its strict CSS colour regex,
// which accepts #RGB/#RRGGBB but not #RRGGBBAA, so translucent colours use rgba().
function toParseableColor(color: CompletionColorData): string {
    if (color.alpha === 255) {
        return `#${[color.red, color.green, color.blue].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    }

    return `rgba(${color.red}, ${color.green}, ${color.blue}, ${(color.alpha / 255).toFixed(3)})`;
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
        !isByte(color.alpha)
    ) {
        return undefined;
    }

    return {
        red: color.red,
        green: color.green,
        blue: color.blue,
        alpha: color.alpha,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isByte(value: unknown): value is number {
    return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 255;
}
