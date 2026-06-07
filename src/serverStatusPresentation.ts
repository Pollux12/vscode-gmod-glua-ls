export interface ServerStatusPresentationInput {
    readonly state: string;
    readonly message?: string;
    readonly details?: string;
    readonly diagnosticsInProgress?: boolean;
}

export interface ServerStatusPresentation {
    readonly icon: string;
    readonly statusLabel: string;
    readonly message: string;
    readonly statusBarText: string;
}

export function getServerStatusPresentation(
    status: ServerStatusPresentationInput
): ServerStatusPresentation {
    const statusLabel = getStatusLabel(status);
    const icon = getStatusIcon(status.state);
    const message = status.message || getDefaultMessage(statusLabel);

    return {
        icon,
        statusLabel,
        message,
        statusBarText: `${icon}GLuaLS: ${message}`,
    };
}

function getStatusLabel(status: ServerStatusPresentationInput): string {
    if (status.state === 'starting' && status.diagnosticsInProgress === true) {
        return 'diagnosing';
    }

    return status.state;
}

function getStatusIcon(state: string): string {
    switch (state) {
        case 'running':
            return '$(check) ';
        case 'stopped':
            return '$(circle-slash) ';
        case 'warning':
            return '$(warning) ';
        case 'error':
            return '$(error) ';
        default:
            return '$(sync~spin) ';
    }
}

function getDefaultMessage(statusLabel: string): string {
    switch (statusLabel) {
        case 'diagnosing':
            return 'Diagnosing workspace...';
        case 'starting':
            return 'Starting';
        case 'running':
            return 'Running';
        case 'stopping':
            return 'Stopping';
        case 'stopped':
            return 'Stopped';
        case 'warning':
            return 'Warning';
        case 'error':
            return 'Error';
        default:
            return statusLabel;
    }
}
