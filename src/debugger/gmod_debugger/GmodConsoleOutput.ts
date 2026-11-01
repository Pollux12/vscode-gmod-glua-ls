export interface GmodConsoleColor {
  r: number
  g: number
  b: number
  a: number
}

export interface GmodConsoleOutput {
  channel_id?: number
  group?: string
  severity?: number
  source?: string
  timestamp?: number | string
  message?: string
  color?: GmodConsoleColor
}

export interface GmodConsoleLine {
  text: string
  ansi: string
  source: string
  severity?: number
  timestamp?: number | string
}

interface Segment {
  text: string
  color: GmodConsoleColor
}

const DEFAULT_COLOR: GmodConsoleColor = { r: 255, g: 255, b: 255, a: 255 }
const IDLE_FLUSH_MS = 100

function formatTimestamp(timestamp?: number | string): string {
  if (typeof timestamp === 'string' && timestamp.trim().length > 0) {
    return timestamp
  }
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date()
  const hh = `${date.getHours()}`.padStart(2, '0')
  const mm = `${date.getMinutes()}`.padStart(2, '0')
  const ss = `${date.getSeconds()}`.padStart(2, '0')
  const ms = `${date.getMilliseconds()}`.padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function sameColor(left: GmodConsoleColor, right: GmodConsoleColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b
}

function linePrefix(first: GmodConsoleOutput, timestamp: string): string {
  const group = first.group ?? first.source
  return typeof group === 'string' && group.trim().length > 0
    ? `[${timestamp}] [${group}] `
    : `[${timestamp}] `
}

/** Joins the fragments the game writes for one console line (one per `print` argument) into whole lines. */
export class GmodConsoleLineAssembler {
  private segments: Segment[] = []
  private first?: GmodConsoleOutput
  private firstTimestamp = ''
  private idleFlush?: NodeJS.Timeout

  public constructor(
    private readonly emit: (line: GmodConsoleLine) => void,
    private readonly idleFlushMs = IDLE_FLUSH_MS
  ) {}

  public push(output: GmodConsoleOutput): void {
    const color = output.color ?? DEFAULT_COLOR
    const parts = (output.message ?? '').split(/\r?\n/)
    parts.forEach((part, index) => {
      if (index > 0) {
        this.emitLine(output)
      }
      if (part.length > 0) {
        this.append(output, part, color)
      }
    })
    this.scheduleIdleFlush()
  }

  public flush(): void {
    this.cancelIdleFlush()
    if (this.first) {
      this.emitLine(this.first)
    }
  }

  private append(output: GmodConsoleOutput, text: string, color: GmodConsoleColor): void {
    if (!this.first) {
      this.first = output
      this.firstTimestamp = formatTimestamp(output.timestamp)
    }
    const last = this.segments[this.segments.length - 1]
    if (last && sameColor(last.color, color)) {
      last.text += text
    } else {
      this.segments.push({ text, color })
    }
  }

  private emitLine(fallback: GmodConsoleOutput): void {
    const first = this.first ?? fallback
    const prefix = this.first ? linePrefix(this.first, this.firstTimestamp) : ''
    const body = this.segments.map((segment) => segment.text).join('')
    const ansiBody = this.segments
      .map(({ text, color }) => `\u001b[38;2;${color.r};${color.g};${color.b}m${text}`)
      .join('')
    this.emit({
      text: `${prefix}${body}\n`,
      ansi: this.segments.length > 0 ? `${prefix}${ansiBody}\u001b[0m\n` : '\n',
      source: first.source ?? first.group ?? 'console',
      severity: first.severity,
      timestamp: first.timestamp,
    })
    this.segments = []
    this.first = undefined
  }

  private scheduleIdleFlush(): void {
    this.cancelIdleFlush()
    if (this.first) {
      this.idleFlush = setTimeout(() => this.flush(), this.idleFlushMs)
    }
  }

  private cancelIdleFlush(): void {
    if (this.idleFlush) {
      clearTimeout(this.idleFlush)
      this.idleFlush = undefined
    }
  }
}
