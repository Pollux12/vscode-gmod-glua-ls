import * as vscode from 'vscode';
import { AnnotatorType } from './lspExtension';
import { LanguageClient } from 'vscode-languageclient/node';
import * as notifications from "./lspExtension";
import { get } from './configManager';
import {
    isExpectedLifecycleRequestError,
    isServerInitializingError,
    sendRequestWithStartupRetry,
} from './languageServerRequests';

// 装饰器类型映射接口
interface DecorationMap {
    [AnnotatorType.ReadOnlyParam]: vscode.TextEditorDecorationType;
    [AnnotatorType.Global]: vscode.TextEditorDecorationType;
    [AnnotatorType.ReadOnlyLocal]: vscode.TextEditorDecorationType;
    [AnnotatorType.MutLocal]: vscode.TextEditorDecorationType;
    [AnnotatorType.MutParam]: vscode.TextEditorDecorationType;
    [AnnotatorType.DocEm]: vscode.TextEditorDecorationType;
    [AnnotatorType.DocStrong]: vscode.TextEditorDecorationType;
}

// 装饰器缓存
const decorationCache = new Map<string, vscode.TextEditorDecorationType>();

// 当前装饰器实例
let decorations: Partial<DecorationMap> = {};

/**
 * 创建装饰器的工厂函数
 */
const createDecoration = (cacheKeySuffix: string): vscode.TextEditorDecorationType => {
    const cacheKey = `decoration:${cacheKeySuffix}`;
    if (decorationCache.has(cacheKey)) {
        return decorationCache.get(cacheKey)!;
    }

    const config: vscode.DecorationRenderOptions = {};
    const decoration = vscode.window.createTextEditorDecorationType(config);
    decorationCache.set(cacheKey, decoration);
    return decoration;
};

/**
 * 创建带下划线的装饰器
 */
const createDecorationUnderline = (cacheKeySuffix: string): vscode.TextEditorDecorationType => {
    const cacheKey = `underline:${cacheKeySuffix}`;
    if (decorationCache.has(cacheKey)) {
        return decorationCache.get(cacheKey)!;
    }

    const config: vscode.DecorationRenderOptions = {};
    const textDecoration = 'underline;text-underline-offset: 4px;';
    config.light = { textDecoration };
    config.dark = { textDecoration };

    const decoration = vscode.window.createTextEditorDecorationType(config);
    decorationCache.set(cacheKey, decoration);
    return decoration;
};

const shouldUnderlineAnnotatorType = (
    config: vscode.WorkspaceConfiguration,
    type: AnnotatorType
): boolean => {
    switch (type) {
        case AnnotatorType.ReadOnlyParam:
            return get<boolean>(config, "gluals.decorations.readonlyParameterUnderline", false) ?? false;
        case AnnotatorType.Global:
            return get<boolean>(config, "gluals.decorations.globalUnderline", false) ?? false;
        case AnnotatorType.ReadOnlyLocal:
            return get<boolean>(config, "gluals.decorations.readonlyLocalUnderline", false) ?? false;
        case AnnotatorType.MutLocal:
            return get<boolean>(config, "gluals.decorations.mutableLocalUnderline", false) ?? false;
        case AnnotatorType.MutParam:
            return get<boolean>(config, "gluals.decorations.mutableParameterUnderline", false) ?? false;
        default:
            return false;
    }
};

const createDecorationDocEm = (): vscode.TextEditorDecorationType => {
    const cacheKey = `decoration:doc.em`;
    if (decorationCache.has(cacheKey)) {
        return decorationCache.get(cacheKey)!;
    }

    const config: vscode.DecorationRenderOptions = {
        light: {
            fontStyle: "italic",
        },
        dark: {
            fontStyle: "italic",
        },
    };
    const decoration = vscode.window.createTextEditorDecorationType(config);
    decorationCache.set(cacheKey, decoration);
    return decoration;
};

const createDecorationDocStrong = (): vscode.TextEditorDecorationType => {
    const cacheKey = `decoration:doc.strong`;
    if (decorationCache.has(cacheKey)) {
        return decorationCache.get(cacheKey)!;
    }

    const config: vscode.DecorationRenderOptions = {
        light: {
            fontWeight: "bold",
        },
        dark: {
            fontWeight: "bold",
        },
    };
    const decoration = vscode.window.createTextEditorDecorationType(config);
    decorationCache.set(cacheKey, decoration);
    return decoration;
};

/**
 * 批量释放装饰器
 */
const disposeDecorations = (...decorationTypes: (vscode.TextEditorDecorationType | undefined)[]): void => {
    decorationTypes.forEach(decoration => decoration?.dispose());
};

/**
 * 更新所有装饰器实例
 */
const updateDecorations = (): void => {
    // 清理旧的装饰器
    if (Object.keys(decorations).length > 0) {
        disposeDecorations(...Object.values(decorations));
        decorations = {};
    }

    // 创建基础装饰器
    const config = vscode.workspace.getConfiguration(
        undefined,
        vscode.window.activeTextEditor?.document.uri
    );

    const createAnnotatorDecoration = (
        type: AnnotatorType,
        cacheKeySuffix: string
    ): vscode.TextEditorDecorationType => {
        if (shouldUnderlineAnnotatorType(config, type)) {
            return createDecorationUnderline(cacheKeySuffix);
        }

        return createDecoration(cacheKeySuffix);
    };

    decorations[AnnotatorType.ReadOnlyParam] = createAnnotatorDecoration(
        AnnotatorType.ReadOnlyParam,
        "readonly-param"
    );
    decorations[AnnotatorType.Global] = createAnnotatorDecoration(
        AnnotatorType.Global,
        "global"
    );
    decorations[AnnotatorType.ReadOnlyLocal] = createAnnotatorDecoration(
        AnnotatorType.ReadOnlyLocal,
        "readonly-local"
    );
    decorations[AnnotatorType.MutLocal] = createAnnotatorDecoration(
        AnnotatorType.MutLocal,
        "mutable-local"
    );
    decorations[AnnotatorType.MutParam] = createAnnotatorDecoration(
        AnnotatorType.MutParam,
        "mutable-param"
    );

    decorations[AnnotatorType.DocEm] = createDecorationDocEm();
    decorations[AnnotatorType.DocStrong] = createDecorationDocStrong();
};

/**
 * 配置变化时的处理函数
 */
export const onDidChangeConfiguration = (): void => {
    // 清理缓存，强制重新创建装饰器
    decorationCache.clear();
    updateDecorations();
};

// 防抖定时器
let timeoutToReqAnn: NodeJS.Timer | undefined;

/**
 * 请求注释器 - 带防抖功能
 */
export const requestAnnotators = (editor: vscode.TextEditor, client: LanguageClient): void => {
    if (timeoutToReqAnn) {
        clearTimeout(timeoutToReqAnn);
    }
    timeoutToReqAnn = setTimeout(() => {
        requestAnnotatorsImpl(editor, client);
    }, 150);
};

/**
 * 异步请求注释器实现
 */
const requestAnnotatorsImpl = async (editor: vscode.TextEditor, client: LanguageClient): Promise<void> => {
    // 确保装饰器已初始化
    if (Object.keys(decorations).length === 0) {
        updateDecorations();
    }

    const params: notifications.AnnotatorParams = {
        uri: editor.document.uri.toString()
    };

    try {
        const annotationList = await sendRequestWithStartupRetry<notifications.IAnnotator[]>(
            client,
            "gluals/annotator",
            params,
        );

        if (!annotationList) {
            return;
        }

        // 使用 Map 来优化数据收集
        const rangeMap = new Map<AnnotatorType, vscode.Range[]>([
            [AnnotatorType.ReadOnlyParam, []],
            [AnnotatorType.Global, []],
            [AnnotatorType.ReadOnlyLocal, []],
            [AnnotatorType.MutLocal, []],
            [AnnotatorType.MutParam, []],
            [AnnotatorType.DocEm, []],
            [AnnotatorType.DocStrong, []],
        ]);

        // 批量处理注释
        for (const annotation of annotationList) {
            const ranges = rangeMap.get(annotation.type);
            if (ranges) {
                ranges.push(...annotation.ranges);
            }
        }

        // 批量更新装饰器
        rangeMap.forEach((ranges, type) => {
            updateAnnotators(editor, type, ranges);
        });
    } catch (error) {
        if (isServerInitializingError(error)) {
            if (vscode.window.activeTextEditor?.document === editor.document) {
                requestAnnotators(editor, client);
            }
            return;
        }

        if (isExpectedLifecycleRequestError(error)) {
            return;
        }

        console.error('Failed to get annotations from language server:', error);
    }
};

/**
 * 更新编辑器中特定类型的注释器
 */
const updateAnnotators = (
    editor: vscode.TextEditor,
    type: AnnotatorType,
    ranges: vscode.Range[]
): void => {
    const decoration = decorations[type];
    if (decoration) {
        editor.setDecorations(decoration, ranges);
    }
};

/**
 * 清理所有缓存和装饰器 - 用于扩展停用时清理
 */
export const dispose = (): void => {
    // 清理防抖定时器
    if (timeoutToReqAnn) {
        clearTimeout(timeoutToReqAnn);
        timeoutToReqAnn = undefined;
    }

    // 清理所有装饰器
    disposeDecorations(...Object.values(decorations));
    decorations = {};

    // 清理缓存中的装饰器
    decorationCache.forEach(decoration => decoration.dispose());
    decorationCache.clear();
};
