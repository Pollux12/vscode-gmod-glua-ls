import { LanguageClient } from 'vscode-languageclient/node';

const CONTENT_MODIFIED_ERROR_CODE = -32801;
const REQUEST_CANCELLED_ERROR_CODE = -32800;

interface ResponseErrorLike {
    code?: unknown;
    message?: unknown;
}

function asResponseErrorLike(error: unknown): ResponseErrorLike | undefined {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    return error as ResponseErrorLike;
}

export function isServerInitializingError(error: unknown): boolean {
    const responseError = asResponseErrorLike(error);
    if (!responseError || responseError.code !== CONTENT_MODIFIED_ERROR_CODE) {
        return false;
    }

    if (typeof responseError.message !== 'string') {
        return true;
    }

    return responseError.message.toLowerCase().includes('server initializing');
}

export function isRequestCancelledError(error: unknown): boolean {
    const responseError = asResponseErrorLike(error);
    return responseError?.code === REQUEST_CANCELLED_ERROR_CODE;
}

export function isExpectedLifecycleRequestError(error: unknown): boolean {
    return isServerInitializingError(error) || isRequestCancelledError(error);
}

export async function sendRequestWithStartupRetry<T>(
    client: LanguageClient,
    method: string,
    params: unknown,
    maxRetries: number = 3,
    retryDelayMs: number = 150,
): Promise<T> {
    let attempt = 0;

    for (;;) {
        try {
            return await client.sendRequest<T>(method, params);
        } catch (error) {
            if (!isServerInitializingError(error) || attempt >= maxRetries) {
                throw error;
            }

            attempt += 1;
            await delay(retryDelayMs * attempt);
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
