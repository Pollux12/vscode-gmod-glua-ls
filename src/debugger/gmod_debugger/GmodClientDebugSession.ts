import {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  ContinuedEvent,
  StoppedEvent,
  OutputEvent,
  Event as DebugEvent,
  Thread,
  StackFrame,
  Scope,
  Source,
  Handles,
  Breakpoint,
} from '@vscode/debugadapter'
import { DebugProtocol } from '@vscode/debugprotocol'
import { readFileSync } from 'fs'
import * as path from 'path'
import { LRDBAdapter, LRDBClient } from './lrdb'
import { JsonRpcNotify } from './lrdb/JsonRpc'
import {
  EvalRequest,
  ExitNotify,
  GetGlobalRequest,
  GmodErrorNotify,
  GetLocalVariableRequest,
  GetUpvaluesRequest,
  PausedNotify,
  RunningNotify,
  SetVarRequest,
} from './lrdb/Client'
import { formatGmodConsoleOutput } from './GmodDebugControlService'

export interface ClientAttachRequestArguments
  extends DebugProtocol.AttachRequestArguments {
  host?: string
  port?: number
  sourceRoot: string
  sourceFileMap?: Record<string, string>
  stopOnEntry?: boolean
  stopOnError?: boolean
}

type GetLocalVariableParam = {
  type: 'get_local_variable'
  params: GetLocalVariableRequest['params']
}
type GetGlobalParam = {
  type: 'get_global'
  params: GetGlobalRequest['params']
}
type GetUpvaluesParam = {
  type: 'get_upvalues'
  params: GetUpvaluesRequest['params']
}
type EvalParam = {
  type: 'eval'
  params: EvalRequest['params']
}

type VariableReference =
  | GetLocalVariableParam
  | GetGlobalParam
  | GetUpvaluesParam
  | EvalParam

export interface ConnectedNotify extends JsonRpcNotify {
  method: 'connected'
  params: {
    lua?: {
      version?: string
    }
    protocol_version?: string
    module_version?: string
  }
}

interface Color {
  r: number
  g: number
  b: number
  a: number
}

interface NotificationOutput {
  channel_id?: number
  severity?: number
  group?: string
  source?: string
  timestamp?: number | string
  color?: Color
  message?: string
}

interface OutputNotify extends JsonRpcNotify {
  method: 'output'
  params: NotificationOutput
}

declare type DebuggerNotify =
  | PausedNotify
  | ConnectedNotify
  | ExitNotify
  | RunningNotify
  | OutputNotify
  | GmodErrorNotify

function stringify_v2(value: unknown): string {
  if (value == null) {
    return 'nil'
  } else if (value === undefined) {
    return 'none'
  } else if (typeof value === 'string') {
    return value
  } else {
    return JSON.stringify(value)
  }
}

export class GmodClientDebugSession extends DebugSession {
  private static THREAD_ID = 1

  private static DEBUGGER_PROTOCOL_VERSION = 'gmod-2'
  private static EXPECTED_GM_RDB_MODULE_VERSION = '1.2.0'

  private _debug_client?: LRDBClient.Client

  private _breakPointID = 1000

  private _variableHandles = new Handles<VariableReference>()

  private _sourceHandles = new Handles<string>()

  private _stopOnEntry?: boolean
  private _stopOnError = false

  private _debuggee_protocol_version?: string
  private _debuggee_module_version?: string
  private _isPaused = false

  public constructor() {
    super()
    this.setDebuggerLinesStartAt1(false)
    this.setDebuggerColumnsStartAt1(false)
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments
  ): void {
    if (this._debug_client) {
      this._debug_client.end()
      delete this._debug_client
    }

    this._debuggee_protocol_version = undefined
    this._debuggee_module_version = undefined
    this._isPaused = false
    this._stopOnError = false
    this.sendEvent(new DebugEvent('gmod.errors.clear'))

    response.body = response.body ?? {}
    response.body.supportsConfigurationDoneRequest = true
    response.body.supportsFunctionBreakpoints = true
    response.body.supportsConditionalBreakpoints = true
    response.body.supportsHitConditionalBreakpoints = true
    response.body.supportsEvaluateForHovers = true
    response.body.supportsSetVariable = true
    response.body.supportsSetExpression = false
    response.body.supportTerminateDebuggee = false
    response.body.supportsLogPoints = false

    this.sendResponse(response)
  }

  private setupSourceEnv(
    sourceRoot: string,
    sourceFileMap?: Record<string, string>
  ) {
    this.convertClientLineToDebugger = (line: number): number => line

    this.convertDebuggerLineToClient = (line: number): number => line

    this.convertClientPathToDebugger = (clientPath: string): string => {
      if (sourceFileMap) {
        for (const sourceFileMapSource of Object.keys(sourceFileMap)) {
          const sourceFileMapTarget = sourceFileMap[sourceFileMapSource]
          const resolvedSource = path.resolve(sourceFileMapSource)
          const resolvedClient = path.resolve(clientPath)
          const relativePath = path.relative(resolvedSource, resolvedClient)
          if (!relativePath.startsWith('..')) {
            return path.join(sourceFileMapTarget, relativePath)
          }
        }
      }

      return path.relative(sourceRoot, clientPath)
    }

    this.convertDebuggerPathToClient = (debuggerPath: string): string => {
      if (!debuggerPath.startsWith('@')) {
        return ''
      }

      const filename = debuggerPath.substr(1)
      if (sourceFileMap) {
        for (const sourceFileMapSource of Object.keys(sourceFileMap)) {
          const sourceFileMapTarget = sourceFileMap[sourceFileMapSource]
          const relativePath = path.relative(sourceFileMapTarget, filename)
          if (!relativePath.startsWith('..')) {
            return path.join(sourceFileMapSource, relativePath)
          }
        }
      }

      if (path.isAbsolute(filename)) {
        return filename
      } else {
        return path.join(sourceRoot, filename)
      }
    }
  }

  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    args: ClientAttachRequestArguments
  ): void {
    try {
      this._stopOnEntry = args.stopOnEntry
      this._stopOnError = args.stopOnError ?? false
      this.sendEvent(new DebugEvent('gmod.errors.clear'))

      this.setupSourceEnv(args.sourceRoot, args.sourceFileMap)

      const port = args.port ?? 21112
      const host = args.host ?? 'localhost'

      this.sendEvent(new OutputEvent(`[Client] Debugger connecting to ${host}:${port} ...\n`))
      this._debug_client = new LRDBClient.Client(
        new LRDBAdapter.TcpAdapter(port, host)
      )

      this._debug_client.onNotify.on((event) => {
        const notify = event as DebuggerNotify
        if (notify.method === 'error') {
          return
        }
        this.handleServerEvents(notify)
      })

      this._debug_client.onError((notify) => {
        this.handleServerEvents(notify)
      })

      this._debug_client.onClose.on(() => {
        this.sendEvent(new OutputEvent(`[Client] Debugger disconnected.\n`))
        this.sendEvent(new TerminatedEvent())
      })

      this._debug_client.onOpen.on(() => {
        this.sendEvent(new OutputEvent(`[Client] Debugger connected!\n`))
        const data = {
          protocol_version: GmodClientDebugSession.DEBUGGER_PROTOCOL_VERSION,
          stop_on_error: this._stopOnError,
        }
        this._debug_client?.init(data)
          .then(() => {
            // no-op
          })
          .catch((error) => {
            this.handleInitError(error)
          })
        this.sendEvent(new InitializedEvent())
      })

      this._debug_client.onTransportError.on((err) => {
        this.sendEvent(new OutputEvent(`[Client] Debugger transport error: ${err.message}. Waiting for client to reconnect...\n`))
      })

      this.sendResponse(response)
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse
  ): void {
    this.sendResponse(response)
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments
  ): void {
    try {
      if (this._debug_client) {
        this._debug_client.end()
        delete this._debug_client
      }

      this._isPaused = false

      this.sendResponse(response)
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    try {
      const filePath = args.source.path
      if (!this._debug_client || !filePath) {
        response.success = false
        this.sendResponse(response)
        return
      }

      const lines = readFileSync(filePath).toString().split('\n')
      const breakpoints: DebugProtocol.Breakpoint[] = []
      const debuggerFilePath = this.convertClientPathToDebugger(filePath)

      this._debug_client.clearBreakPoints({ file: debuggerFilePath })
        .catch((err: Error) => {
          this.sendEvent(new OutputEvent(`[Client] Warning: failed to clear breakpoints for '${debuggerFilePath}': ${err.message}\n`, 'stderr'))
        })

      if (args.breakpoints) {
        for (const sourceBreakpoint of args.breakpoints) {
          let l = this.convertClientLineToDebugger(sourceBreakpoint.line)
          let verified = false
          const isLogPoint = !!sourceBreakpoint.logMessage
          if (!isLogPoint) {
            while (l <= lines.length) {
              const line = lines[l - 1].trim()
              if (line.length === 0 || line.startsWith('--')) {
                l++
              } else {
                verified = true
                break
              }
            }
          }

          const bp: DebugProtocol.Breakpoint = new Breakpoint(
            verified,
            this.convertDebuggerLineToClient(l)
          )
          bp.id = this._breakPointID++
          if (isLogPoint) {
            bp.message = 'Logpoints are not supported by gluals_gmod_client; use a conditional breakpoint instead.'
          }
          breakpoints.push(bp)
          if (verified) {
            this._debug_client.addBreakPoint({
              line: l,
              file: debuggerFilePath,
              condition: sourceBreakpoint.condition,
              hit_condition: sourceBreakpoint.hitCondition,
            }).catch((err: Error) => {
              this.sendEvent(new OutputEvent(`[Client] Failed to set breakpoint at '${debuggerFilePath}:${l}': ${err.message}\n`, 'stderr'))
            })
          }
        }
      }

      response.body = { breakpoints }
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: [new Thread(GmodClientDebugSession.THREAD_ID, 'client thread 1')],
    }
    this.sendResponse(response)
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    try {
      if (!this._debug_client) {
        response.success = false
        this.sendResponse(response)
        return
      }

      this._debug_client.getStackTrace().then((res) => {
        if (res.result) {
          const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0
          const maxLevels = typeof args.levels === 'number'
            ? args.levels
            : res.result.length - startFrame
          const endFrame = Math.min(startFrame + maxLevels, res.result.length)
          const frames: StackFrame[] = []
          for (let i = startFrame; i < endFrame; i++) {
            const frame = res.result[i]
            if (frame.file === undefined) frame.file = ''
            if (frame.func === undefined) frame.func = ''
            const filename = this.convertDebuggerPathToClient(frame.file)
            const source = new Source(frame.id, filename)
            if (!frame.file.startsWith('@')) {
              source.sourceReference = this._sourceHandles.create(frame.file)
            }
            frames.push(
              new StackFrame(
                i,
                frame.func,
                source,
                this.convertDebuggerLineToClient(frame.line),
                0
              )
            )
          }

          response.body = {
            stackFrames: frames,
            totalFrames: res.result.length,
          }
        } else {
          response.success = false
          response.message = 'unknown error'
        }

        this.sendResponse(response)
      }).catch((err) => {
        response.success = false
        response.message = err instanceof Error ? err.message : String(err)
        this.sendResponse(response)
      })
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    try {
      const scopes = [
        new Scope(
          'Local',
          this._variableHandles.create({
            type: 'get_local_variable',
            params: { stack_no: args.frameId },
          }),
          false
        ),
        new Scope(
          'Upvalues',
          this._variableHandles.create({
            type: 'get_upvalues',
            params: { stack_no: args.frameId },
          }),
          false
        ),
        new Scope(
          'Global',
          this._variableHandles.create({
            type: 'get_global',
            params: {},
          }),
          true
        ),
      ]
      response.body = { scopes }
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): void {
    try {
      if (!this._debug_client) {
        response.success = false
        this.sendResponse(response)
        return
      }

      const parent = this._variableHandles.get(args.variablesReference)
      if (parent != null) {
        const res = (() => {
          switch (parent.type) {
            case 'get_global':
              return this._debug_client.getGlobal(parent.params).then((r) => r.result)
            case 'get_local_variable':
              return this._debug_client.getLocalVariable(parent.params).then((r) => r.result)
            case 'get_upvalues':
              return this._debug_client.getUpvalues(parent.params).then((r) => r.result)
            case 'eval':
              return this._debug_client.eval(parent.params).then((r) => {
                const results = r.result as unknown[]
                return results[0]
              })
            default:
              return Promise.reject(new Error('invalid'))
          }
        })()

        res
          .then((result) => this.variablesRequestResponse(response, result, parent))
          .catch((err) => {
            response.success = false
            response.message = err instanceof Error ? err.message : String(err)
            this.sendResponse(response)
          })
      } else {
        response.success = false
        this.sendResponse(response)
      }
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  private variablesRequestResponse(
    response: DebugProtocol.VariablesResponse,
    variablesData: unknown,
    parent: VariableReference
  ): void {
    try {
      const evalParam = (k: unknown): EvalParam => {
        switch (parent.type) {
          case 'eval': {
            const key = typeof k === 'string' ? `"${k}"` : `${k}`
            return {
              type: 'eval',
              params: { ...parent.params, chunk: `(${parent.params.chunk})[${key}]` },
            }
          }
          default: {
            return {
              type: 'eval',
              params: {
                stack_no: 0,
                ...parent.params,
                chunk: `${k}`,
                upvalue: parent.type === 'get_upvalues',
                local: parent.type === 'get_local_variable',
                global: parent.type === 'get_global',
              },
            }
          }
        }
      }

      const variables: DebugProtocol.Variable[] = []
      if (variablesData instanceof Array) {
        variablesData.forEach((v, i) => {
          const typename = typeof v
          const k = i + 1
          const varRef = typename === 'object' ? this._variableHandles.create(evalParam(k)) : 0
          variables.push({ name: `${k}`, type: typename, value: stringify_v2(v), variablesReference: varRef })
        })
      } else if (typeof variablesData === 'object' && variablesData !== null) {
        const varData = variablesData as Record<string, unknown>
        for (const k in varData) {
          const typename = typeof varData[k]
          const varRef = typename === 'object' ? this._variableHandles.create(evalParam(k)) : 0
          variables.push({ name: k, type: typename, value: stringify_v2(varData[k]), variablesReference: varRef })
        }
      }

      response.body = { variables }
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments
  ): void {
    try {
      this._debug_client?.continue()
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      response.message = e instanceof Error ? `Debug Adapter exception: ${e.message}` : `Debug Adapter exception: ${e}`
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
    try {
      this._debug_client?.step()
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      response.message = e instanceof Error ? `Debug Adapter exception: ${e.message}` : `Debug Adapter exception: ${e}`
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
    try {
      this._debug_client?.stepIn()
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      response.message = e instanceof Error ? `Debug Adapter exception: ${e.message}` : `Debug Adapter exception: ${e}`
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): void {
    try {
      this._debug_client?.stepOut()
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      response.message = e instanceof Error ? `Debug Adapter exception: ${e.message}` : `Debug Adapter exception: ${e}`
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): void {
    try {
      this._debug_client?.pauseNow()
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      response.message = e instanceof Error ? `Debug Adapter exception: ${e.message}` : `Debug Adapter exception: ${e}`
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments
  ): void {
    try {
      const id = this._sourceHandles.get(args.sourceReference)
      if (id) {
        response.body = { content: id }
      }
      this.sendResponse(response)
    } catch (e) {
      response.success = false
      response.message = e instanceof Error ? `Debug Adapter exception: ${e.message}` : `Debug Adapter exception: ${e}`
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  protected setExpressionRequest(
    response: DebugProtocol.SetExpressionResponse,
    args: DebugProtocol.SetExpressionArguments
  ): void {
    response.success = false
    response.message = 'setExpression is not supported by gluals_gmod_client.'
    response.body = { value: args.value, type: 'string', variablesReference: 0 }
    this.sendResponse(response)
  }

  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): void {
    try {
      if (!this._debug_client) {
        response.success = false
        this.sendResponse(response)
        return
      }

      const expression = args.expression.trim()

      if (args.context === 'repl') {
        // Client session only supports Lua eval (prefixed with = or lua/eval).
        // Console commands are not available on the client debugger.
        const explicitLuaPrefix = /^(lua|eval)\s+/i
        const isLuaPrefix = expression.startsWith('=') || explicitLuaPrefix.test(expression)

        if (!isLuaPrefix) {
          response.success = false
          response.message = 'The client debugger does not support console commands. Use = or "eval " to evaluate Lua expressions.'
          this.sendResponse(response)
          return
        }

        if (!this._isPaused) {
          response.success = false
          response.message = 'Evaluation is only available when execution is paused.'
          this.sendResponse(response)
          return
        }

        let luaExpression: string
        if (expression.startsWith('=')) {
          luaExpression = expression.slice(1).trim()
        } else {
          luaExpression = expression.replace(explicitLuaPrefix, '').trim()
        }

        if (luaExpression.length === 0) {
          response.success = false
          response.message = 'Lua expression is empty.'
          this.sendResponse(response)
          return
        }

        this.performEval(response, luaExpression, args.frameId)
        return
      }

      // hover / watch context
      this.performEval(response, expression, args.frameId)
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  private performEval(
    response: DebugProtocol.EvaluateResponse,
    chunk: string,
    frameId?: number
  ): void {
    if (!this._debug_client) {
      response.success = false
      this.sendResponse(response)
      return
    }

    const requestParam: EvalRequest['params'] = {
      stack_no: frameId as number,
      chunk,
      depth: 0,
    }

    this._debug_client.eval(requestParam)
      .then((res) => {
        if (res.result instanceof Array) {
          const ret = res.result.map((v) => stringify_v2(v)).join('\t')
          let varRef = 0
          if (res.result.length === 1) {
            const refobj = res.result[0]
            if (refobj && typeof refobj === 'object') {
              varRef = this._variableHandles.create({ type: 'eval', params: requestParam })
            }
          }
          response.body = { result: ret, variablesReference: varRef }
        } else {
          response.body = { result: '', variablesReference: 0 }
          response.success = false
        }
        this.sendResponse(response)
      })
      .catch((err: Error) => {
        this.sendErrorResponse(response, 1001, err.message || 'Request failed')
      })
  }

  protected setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments
  ): void {
    try {
      if (!this._debug_client) {
        response.success = false
        this.sendResponse(response)
        return
      }

      const parent = this._variableHandles.get(args.variablesReference)
      let varScope = 'local'
      let stackNo = 0
      if (parent != null) {
        if (parent.type === 'get_local_variable') {
          varScope = 'local'
          const lp = parent.params as GetLocalVariableRequest['params']
          if (lp.stack_no) stackNo = lp.stack_no
        } else if (parent.type === 'get_upvalues') {
          varScope = 'up'
          const lp = parent.params as GetUpvaluesRequest['params']
          if (lp.stack_no) stackNo = lp.stack_no
        } else if (parent.type === 'get_global') {
          varScope = 'global'
        }
      }

      let value: string | number | boolean = args.value
      if (value === 'true') {
        value = true
      } else if (value === 'false') {
        value = false
      }
      if (typeof value === 'string' && String(Number(value)) === value) {
        value = Number(value)
      }

      const params: SetVarRequest['params'] = {
        name: args.name,
        value,
        scope: varScope,
        stackNo,
      }

      this._debug_client.setVar(params)
        .then((res) => {
          response.success = res.result
          if (response.success) {
            response.body = { value: args.value }
          }
          this.sendResponse(response)
        })
        .catch((err: Error) => {
          this.sendErrorResponse(response, 1001, err.message || 'Request failed')
        })
    } catch (e) {
      response.success = false
      if (typeof e === 'string') {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent((response.message ?? '') + '\n'))
      this.sendResponse(response)
    }
  }

  private handleServerEvents(event: DebuggerNotify) {
    try {
      switch (event.method) {
        case 'paused':
          if (event.params.reason === 'entry' && !this._stopOnEntry) {
            this._isPaused = false
            this._debug_client?.continue()
          } else {
            this._isPaused = true
            this.sendEvent(new StoppedEvent(event.params.reason, GmodClientDebugSession.THREAD_ID))
          }
          break

        case 'running':
          this._isPaused = false
          this._variableHandles.reset()
          this.sendEvent(new ContinuedEvent(GmodClientDebugSession.THREAD_ID))
          break

        case 'exit':
          break

        case 'connected':
          this._debuggee_protocol_version = event.params.protocol_version
          this._debuggee_module_version = event.params.module_version
          this.sendEvent(new DebugEvent('gmod.client.connected', {
            protocolVersion: this._debuggee_protocol_version,
            moduleVersion: this._debuggee_module_version,
          }))
          this.sendEvent(
            new OutputEvent(
              `[Client] Debugger metadata: protocol=${this._debuggee_protocol_version ?? 'unknown'}, module=${this._debuggee_module_version ?? 'unknown'}\n`
            )
          )

          if (
            this._debuggee_module_version &&
            this._debuggee_module_version !== GmodClientDebugSession.EXPECTED_GM_RDB_MODULE_VERSION
          ) {
            this.sendEvent(new DebugEvent('gmod.rdb.client.versionMismatch', {
              moduleVersion: this._debuggee_module_version,
              expectedVersion: GmodClientDebugSession.EXPECTED_GM_RDB_MODULE_VERSION,
              protocolVersion: this._debuggee_protocol_version,
            }))
          }
          break

        case 'output': {
          const formatted = formatGmodConsoleOutput(event.params)
          const color = event.params.color ?? { r: 255, g: 255, b: 255, a: 255 }
          this.sendEvent(
            new OutputEvent(
              `\u001b[38;2;${color.r};${color.g};${color.b}m${formatted}\u001b[0m`,
              'stdout'
            )
          )
          this.sendEvent(new DebugEvent('gmod.output', {
            message: formatted,
            source: event.params.source ?? event.params.group ?? 'console',
            severity: event.params.severity,
            timestamp: event.params.timestamp,
            realm: 'client',
          }))
          break
        }

        case 'error': {
          const message = typeof event.params.message === 'string' && event.params.message.trim().length > 0
            ? event.params.message
            : 'Unknown Lua error'
          const fingerprint = typeof event.params.fingerprint === 'string' && event.params.fingerprint.trim().length > 0
            ? event.params.fingerprint
            : `error:${message}`
          const source = event.params.source === 'console' ? 'console' : 'lua'
          const count = Number.isFinite(event.params.count) ? Math.max(1, Math.floor(event.params.count)) : 1
          const rawMessage = typeof event.params.raw_message === 'string' ? event.params.raw_message : ''
          const stackTrace = this.parseGmodErrorStackTrace(rawMessage)

          this.sendEvent(new OutputEvent(`[Client] [${source} error ${count}x] ${message}\n`, 'stderr'))
          this.sendEvent(new DebugEvent('gmod.error', {
            message,
            fingerprint,
            count,
            source,
            stackTrace,
            realm: 'client',
          }))

          if (this._stopOnError) {
            this._debug_client?.pauseNow().catch((error) => {
              this.sendEvent(
                new OutputEvent(
                  `[Client] Failed to stop on error: ${error instanceof Error ? error.message : String(error)}\n`,
                  'stderr'
                )
              )
            })
          }
          break
        }
      }
    } catch (e) {
      if (typeof e === 'string') {
        this.sendEvent(new OutputEvent(`Debug Adapter exception: ${e}\n`))
      } else if (e instanceof Error) {
        this.sendEvent(new OutputEvent(e.message))
      }
    }
  }

  private handleInitError(error: unknown): void {
    const serverProtocolVersion = this.extractServerProtocolVersion(error)
    if (serverProtocolVersion) {
      this.sendEvent(
        new OutputEvent(
          `[Client] Debugger protocol mismatch: client=${GmodClientDebugSession.DEBUGGER_PROTOCOL_VERSION}, server=${serverProtocolVersion}. Update rdb_client or the VS Code extension so versions match.\n`,
          'stderr'
        )
      )
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    this.sendEvent(new OutputEvent(`[Client] Debugger init failed: ${message}\n`, 'stderr'))
  }

  private extractServerProtocolVersion(error: unknown): string | undefined {
    const candidates: unknown[] = []

    if (error && typeof error === 'object') {
      candidates.push(error)
      if ('data' in error) {
        candidates.push((error as Record<string, unknown>).data)
      }
    }

    const errorMessage = (() => {
      if (typeof error === 'string') return error
      if (error instanceof Error) return error.message
      return undefined
    })()

    if (typeof errorMessage === 'string') {
      const trimmed = errorMessage.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown
          candidates.push(parsed)
          if (parsed && typeof parsed === 'object' && 'data' in parsed) {
            candidates.push((parsed as Record<string, unknown>).data)
          }
        } catch {
          // ignore
        }
      }
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue
      const version = (candidate as Record<string, unknown>).server_protocol_version
      if (typeof version === 'string' && version.trim().length > 0) {
        return version.trim()
      }
    }

    return undefined
  }

  private parseGmodErrorStackTrace(rawMessage: string): string[] {
    if (rawMessage.trim().length === 0) return []
    const frames: string[] = []
    const lines = rawMessage.split(/\r?\n/)
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      if (line === '[ERROR]' || /^stack traceback:\s*$/i.test(line)) continue
      if (/^\d+\.\s+/.test(line)) frames.push(line)
    }
    return frames
  }
}
