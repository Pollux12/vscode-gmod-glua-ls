export interface GmodLuaError {
  message: string
  stackTrace: string[]
}

const UNKNOWN_LUA_ERROR = 'Unknown Lua error'

function isStackFrame(line: string): boolean {
  return /^\d+\.\s+/.test(line)
}

function headline(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\[ERROR\]\s*/, '')
    if (line.length > 0 && !isStackFrame(line) && !/^stack traceback:\s*$/i.test(line)) {
      return line
    }
  }
  return undefined
}

function stackFrames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isStackFrame)
}

export function parseGmodLuaError(message: unknown, rawMessage: unknown): GmodLuaError {
  const messageText = typeof message === 'string' ? message : ''
  const rawText = typeof rawMessage === 'string' ? rawMessage : ''
  const rawFrames = stackFrames(rawText)
  return {
    message: headline(messageText) ?? headline(rawText) ?? UNKNOWN_LUA_ERROR,
    stackTrace: rawFrames.length > 0 ? rawFrames : stackFrames(messageText),
  }
}
