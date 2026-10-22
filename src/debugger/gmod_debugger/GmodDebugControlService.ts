import * as fs from 'fs'
import * as path from 'path'
import { clientPathToGamePath, gamePathToLuaPath, GmodSourceMapping } from './GmodSourcePaths'

export const GMOD_REALMS = ['server', 'client', 'shared'] as const
export type GmodRealm = (typeof GMOD_REALMS)[number]

export type GmodControlCommand =
  | 'pauseSoft'
  | 'pauseNow'
  | 'resume'
  | 'breakHere'
  | 'waitIDE'
  | 'runLua'
  | 'runFile'
  | 'refreshFile'
  | 'runCommand'
  | 'setRealm'

export interface GmodControlTransport {
  pauseSoft(): Promise<unknown> | void
  pauseNow(): Promise<unknown> | void
  resume(): Promise<unknown> | void
  runLua(lua: string, realm: GmodRealm): Promise<unknown> | void
  runFile(filePath: string, realm: GmodRealm): Promise<unknown> | void
  refreshFile(filePath: string): Promise<unknown> | void
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

export function normalizeGmodRealm(realm: unknown): GmodRealm {
  if (typeof realm === 'string') {
    const lowered = realm.toLowerCase()
    if (GMOD_REALMS.includes(lowered as GmodRealm)) {
      return lowered as GmodRealm
    }
  }
  return 'server'
}

export class GmodDebugControlService {
  private realm: GmodRealm
  private sourceMapping: GmodSourceMapping
  private seq = 0

  public constructor(
    private readonly transport: GmodControlTransport,
    initialRealm: GmodRealm = 'server',
    sourceMapping: GmodSourceMapping = {}
  ) {
    this.realm = initialRealm
    this.sourceMapping = sourceMapping
  }

  public setSourceMapping(sourceMapping: GmodSourceMapping) {
    this.sourceMapping = sourceMapping
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
    let realm = this.resolveRealm(args.realm)
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
        request = 'run_lua(server): breakHere()'
        await this.transport.runLua('if dbg and dbg.breakHere then dbg.breakHere() end', 'server')
        diagnostics.push({ level: 'info', message: 'breakHere dispatched.' })
        break

      case 'waitIDE': {
        const timeout = typeof args.timeout === 'number' ? Math.max(0, args.timeout) : undefined
        const timeoutExpr = timeout == null ? '' : `${Math.floor(timeout)}`
        const snippet = timeoutExpr.length > 0
          ? `if dbg and dbg.waitIDE then dbg.waitIDE(${timeoutExpr}) end`
          : 'if dbg and dbg.waitIDE then dbg.waitIDE() end'
        request = 'run_lua(server): waitIDE()'
        await this.transport.runLua(snippet, 'server')
        diagnostics.push({ level: 'info', message: 'waitIDE dispatched.' })
        break
      }

      case 'runLua': {
        const lua = typeof args.lua === 'string' ? args.lua : typeof args.chunk === 'string' ? args.chunk : ''
        if (lua.trim().length === 0) {
          diagnostics.push({ level: 'error', message: 'Lua chunk is empty.' })
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        request = `run_lua(${realm}) bytes=${lua.length}`
        await this.transport.runLua(lua, realm)
        diagnostics.push({ level: 'info', message: 'Lua chunk dispatched.' })
        break
      }

      case 'runFile': {
        const luaPath = this.resolveLuaFile(args, diagnostics)
        if (luaPath === undefined) {
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        request = `run_file(${realm}) ${luaPath}`
        await this.transport.runFile(luaPath, realm)
        diagnostics.push({ level: 'info', message: `File dispatched: ${luaPath}` })
        break
      }

      case 'refreshFile': {
        realm = 'server'
        const luaPath = this.resolveLuaFile(args, diagnostics)
        if (luaPath === undefined) {
          return { ok: false, command, realm, correlationId, diagnostics }
        }
        request = `refresh_file(server) ${luaPath}`
        await this.transport.refreshFile(luaPath)
        diagnostics.push({ level: 'info', message: `Refresh dispatched: ${luaPath}` })
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

  private resolveLuaFile(args: Record<string, unknown>, diagnostics: GmodControlDiagnostic[]): string | undefined {
    const inputPath = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : ''
    if (inputPath.trim().length === 0) {
      diagnostics.push({ level: 'error', message: 'File path is required.' })
      return undefined
    }

    const { sourceRoot } = this.sourceMapping
    const resolved = sourceRoot === undefined ? path.resolve(inputPath) : path.resolve(sourceRoot, inputPath)
    if (!fs.existsSync(resolved)) {
      diagnostics.push({ level: 'error', message: `File not found: ${resolved}` })
      return undefined
    }
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) {
      diagnostics.push({ level: 'error', message: `Not a file: ${resolved}` })
      return undefined
    }
    if (stat.size === 0) {
      diagnostics.push({ level: 'warning', message: `File is empty: ${resolved}` })
    }

    const gamePath = clientPathToGamePath(resolved, this.sourceMapping)
    if (gamePath === undefined) {
      diagnostics.push({ level: 'error', message: `File is outside sourceRoot and every sourceFileMap folder: ${resolved}` })
      return undefined
    }
    const luaPath = gamePathToLuaPath(gamePath)
    if (luaPath === undefined) {
      diagnostics.push({
        level: 'error',
        message: `File is not under lua/, gamemodes/, addons/<name>/lua/ or addons/<name>/gamemodes/: ${gamePath}`,
      })
      return undefined
    }
    return luaPath
  }
}
