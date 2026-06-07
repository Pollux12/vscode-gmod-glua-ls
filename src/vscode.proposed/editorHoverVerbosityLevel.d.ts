declare module 'vscode' {
    /**
     * A hover that can be expanded or collapsed by the editor hover UI.
     *
     * This mirrors VS Code's `editorHoverVerbosityLevel` proposed API type so
     * the extension can compile against stable `@types/vscode` while still
     * runtime-checking whether the API is present.
     */
    export class VerboseHover extends Hover {
        canIncreaseVerbosity?: boolean;
        canDecreaseVerbosity?: boolean;

        constructor(
            contents: MarkdownString | MarkedString | Array<MarkdownString | MarkedString>,
            range?: Range,
            canIncreaseVerbosity?: boolean,
            canDecreaseVerbosity?: boolean,
        );
    }

    export interface HoverContext {
        readonly verbosityDelta?: number;
        readonly previousHover?: Hover;
    }

    export enum HoverVerbosityAction {
        Increase = 0,
        Decrease = 1,
    }

    export interface HoverProvider {
        provideHover(
            document: TextDocument,
            position: Position,
            token: CancellationToken,
            context?: HoverContext,
        ): ProviderResult<Hover>;
    }
}
