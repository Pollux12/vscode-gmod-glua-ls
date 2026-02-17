import * as fs from 'fs'
import * as path from 'path'

export const GMOD_REALMS = ['server', 'client', 'menu'] as const
export type GmodRealm = (typeof GMOD_REALMS)[number]

export type GmodControlCommand =
  | 'pauseSoft'
  | 'pauseNow'
  | 'resume'
  | 'breakHere'
  | 'waitIDE'
  | 'runLua'
  | 'runFile'
  | 'runCommand'
  | 'setRealm'

export interface GmodControlTransport {
  pauseSoft(): Promise<unknown> | void
  pauseNow(): Promise<unknown> | void
  resume(): Promise<unknown> | void
  runCommand(command: string): Promise<unknown> | void
}

export interface GmodControlDiagnostic {
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface GmodControlResult {
  ok: boolean
  command: GmodControlCommand
  realm: GmodRealm
  correlationId: string
  request?: string
  diagnostics: GmodControlDiagnostic[]
}

export interface GmodConsoleOutput {
  channel_id?: number
  group?: string
  severity?: number
  source?: string
  timestamp?: number | string
  message?: string
}

export function normalizeGmodRealm(realm: unknown): GmodRealm {
  if (typeof realm === 'string') {
    const lowered = realm.toLowerCase()
    if (GMOD_REALMS.includes(lowered as GmodRealm)) {
      return lowered as GmodRealm
    }
  }
  return 'server'
}

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

export function formatGmodConsoleOutput(params: GmodConsoleOutput): string {
  const source = params.source ?? params.group ?? (params.channel_id != null ? `channel-${params.channel_id}` : 'console')
  const severity = params.severity != null ? `sev:${params.severity}` : 'sev:?'
  const tag = params.channel_id != null ? `ch:${params.channel_id}` : 'ch:?'
  const message = params.message ?? ''
  const line = `[${formatTimestamp(params.timestamp)}] [${source}] [${tag}] [${severity}] ${message}`
  return line.endsWith('\n') ? line : `${line}\n`
}

export class GmodDebugControlService {
  private realm: GmodRealm
  private workspaceRoot?: string
  private seq = 0

  public constructor(
    private readonly transport: GmodControlTransport,
    initialRealm: GmodRealm = 'server',
    workspaceRoot?: string
  ) {
    this.realm = initialRealm
    this.workspaceRoot = workspaceRoot
  }

  public setWorkspaceRoot(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot
  }

  public getRealm(): GmodRealm {
    return this.realm
  }

  public setRealm(realm: unknown): GmodRealm {
    this.realm = normalizeGmodRealm(realm)
    return this.realm
  }

  public async execute(command: GmodControlCommand, args: Record<string, unknown> = {}): Promise<GmodControlResult> {
    const correlationId = this.nextCorrelationId(command)
    const diagnostics: GmodControlDiagnostic[] = []
    const realm = this.resolveRealm(args.realm)
    let request: string | undefined

    switch (command) {
      case 'pauseSoft':
        await this.transport.pauseSoft()
        diagnostics.push({ level: 'info', message: 'Soft pause requested.' })
        break

      case 'pauseNow':
        await this.transport.pauseNow()
        diagnostics.push({ level: 'info', message: 'Immediate pause requested.' })
        break

      case 'resume':
        await this.transport.resume()
        diagnostics.push({ level: 'info', message: 'Resume requested.' })
        break

      case 'setRealm':
        this.setRealm(args.realm)
        diagnostics.push({ level: 'info', message: `Realm set to ${this.realm}.` })
        break

      case 'breakHere':
        request = this.buildLuaRunCommand('if dbg and dbg.breakHere then dbg.breakHere() end', realm)
        await this.transport.runCommand(request)
        diagnostics.push({ level: 'info', message: 'breakHere dispatched.' })
        break

      case 'waitIDE': {
        const timeout = typeof args.timeout === 'number' ? Math.max(0, args.timeout) : undefined
        const timeoutExpr = timeout == null ? '' : `${Math.floor(timeout)}`
        const snippet = timeoutExpr.length > 0
          ? `if dbg and dbg.waitIDE then dbg.waitIDE(${timeoutExpr}) end`
          : 'if dbg and dbg.waitIDE then dbg.waitIDE() end'
        request = this.buildLuaRunCommand(snippet, realm)
        await this.transport.runCommand(request)
        diagnostics.push({ level: 'info', message: 'waitIDE dispatched.' })
        break
      }

      case 'runLua': {
        const lua = typeof args.lua === 'string' ? args.lua : typeof args.chunk === 'string' ? args.chunk : ''
        if (lua.trim().length === 0) {
          diagnostics.push({ level: 'error', message: 'Lua chunk is empty.' })
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        request = this.buildLuaRunCommand(lua, realm)
        await this.transport.runCommand(request)
        diagnostics.push({ level: 'info', message: 'Lua chunk dispatched.' })
        break
      }

      case 'runFile': {
        const inputPath = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : ''
        if (inputPath.trim().length === 0) {
          diagnostics.push({ level: 'error', message: 'File path is required.' })
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        const resolved = this.resolvePath(inputPath)
        if (!fs.existsSync(resolved)) {
          diagnostics.push({ level: 'error', message: `File not found: ${resolved}` })
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        const stat = fs.statSync(resolved)
        if (!stat.isFile()) {
          diagnostics.push({ level: 'error', message: `Not a file: ${resolved}` })
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        if (stat.size === 0) {
          diagnostics.push({ level: 'warning', message: `File is empty: ${resolved}` })
        }
        request = this.buildFileRunCommand(resolved, realm)
        await this.transport.runCommand(request)
        diagnostics.push({ level: 'info', message: `File dispatched: ${resolved}` })
        break
      }

      case 'runCommand': {
        const raw = typeof args.command === 'string' ? args.command : ''
        if (raw.trim().length === 0) {
          diagnostics.push({ level: 'error', message: 'Console command is empty.' })
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        request = raw
        await this.transport.runCommand(raw)
        diagnostics.push({ level: 'info', message: 'Console command dispatched.' })
        break
      }
    }

    return {
      ok: true,
      command,
      realm,
      correlationId,
      request,
      diagnostics,
    }
  }

  private nextCorrelationId(command: GmodControlCommand): string {
    this.seq += 1
    return `${command}-${Date.now().toString(36)}-${this.seq.toString(36)}`
  }

  private resolveRealm(realm: unknown): GmodRealm {
    if (realm == null) {
      return this.realm
    }
    return normalizeGmodRealm(realm)
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return inputPath
    }
    return this.workspaceRoot ? path.resolve(this.workspaceRoot, inputPath) : path.resolve(inputPath)
  }

  private buildLuaRunCommand(lua: string, realm: GmodRealm): string {
    const command = realm === 'client' ? 'lua_run_cl' : realm === 'menu' ? 'lua_run_menu' : 'lua_run'
    const payload = lua.replace(/\r?\n/g, '; ')
    return `${command} ${payload}`
  }

  private buildFileRunCommand(filePath: string, realm: GmodRealm): string {
    const normalized = filePath.replace(/\\/g, '/').replace(/"/g, '\\"')
    const command = realm === 'client'
      ? 'lua_openscript_cl'
      : realm === 'menu'
        ? 'lua_openscript_menu'
        : 'lua_openscript'
    return `${command} "${normalized}"`
  }
}
