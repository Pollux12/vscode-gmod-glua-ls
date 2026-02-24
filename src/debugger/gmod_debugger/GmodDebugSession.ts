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
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import { LRDBAdapter, LRDBClient } from './lrdb'
import { JsonRpcNotify } from './lrdb/JsonRpc'
import {
  EntityDetail,
  GetEntityNetworkVarsResult,
  GetEntityTableResult,
  EvalRequest,
  ExitNotify,
  GetEntitiesParams,
  GetEntitiesResult,
  GetGlobalRequest,
  GmodErrorNotify,
  GetLocalVariableRequest,
  GetUpvaluesRequest,
  PausedNotify,
  RunningNotify,
  SetEntityPropertyParams,
  SetVarRequest,
} from './lrdb/Client'
import {
  formatGmodConsoleOutput,
  GmodControlCommand,
  GmodControlResult,
  GmodDebugControlService,
  GmodRealm,
  normalizeGmodRealm,
} from './GmodDebugControlService'

export interface LaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments {
  program: string
  args?: string[]
  cwd?: string
  port?: number
  sourceRoot?: string
  sourceFileMap?: Record<string, string>
  stopOnEntry?: boolean
  stopOnError?: boolean
  realm?: GmodRealm
}

export interface AttachRequestArguments
  extends DebugProtocol.AttachRequestArguments {
  host?: string
  port?: number
  sourceRoot: string
  sourceFileMap?: Record<string, string>
  stopOnEntry?: boolean
  stopOnError?: boolean
  realm?: GmodRealm
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
      productName?: string
      productVersion?: string
      shipping?: boolean
      vmType?: string
    },
    working_directory?: string,
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

// values are plain JSON (strings, numbers, booleans, objects)
function stringify_v2(value: unknown): string {
  if (value == null) {
    return 'nil'
  } else if (value == undefined) {
    return 'none'
  } else if (typeof value === 'string') { // prevent putting quotes around the value
    return value
  } else {
    return JSON.stringify(value)
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (_error) {
  }
}

export class GmodDebugSession extends DebugSession {
  // Lua
  private static THREAD_ID = 1

  private static DEBUGGER_PROTOCOL_VERSION = 'gmod-2'
  private static EXPECTED_GM_RDB_MODULE_VERSION = '1.2.0'
  private static CONTROL_COMMANDS: ReadonlySet<GmodControlCommand> = new Set([
    'pauseSoft',
    'pauseNow',
    'resume',
    'breakHere',
    'waitIDE',
    'runLua',
    'runFile',
    'runCommand',
    'setRealm',
  ])

  private _debug_server_process?: ChildProcess

  private _debug_client?: LRDBClient.Client

  private _breakPointID = 1000

  private _variableHandles = new Handles<VariableReference>()

  private _sourceHandles = new Handles<string>()

  private _stopOnEntry?: boolean
  private _stopOnError = false

  private _debuggee_protocol_version?: string
  private _debuggee_module_version?: string
  private _controlService?: GmodDebugControlService
  private _sourceRoot?: string
  private _configurationDoneReceived = false
  private _serverInitCompleted = false
  private _isPaused = false

  /**
   * Creates a new debug adapter that is used for one debug session.
   * We configure the default implementation of a debug adapter here.
   */
  public constructor() {
    super()

    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false)
    this.setDebuggerColumnsStartAt1(false)
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments
  ): void {
    if (this._debug_server_process) {
      if (this._debug_server_process.pid) {
        killProcess(this._debug_server_process.pid)
      }

      delete this._debug_server_process
    }

    if (this._debug_client) {
      this._debug_client.end()
      delete this._debug_client
    }

    this._debuggee_protocol_version = undefined
    this._debuggee_module_version = undefined
    this._configurationDoneReceived = false
    this._serverInitCompleted = false
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
    this.convertClientLineToDebugger = (line: number): number => {
      return line
    }

    this.convertDebuggerLineToClient = (line: number): number => {
      return line
    }

    this.convertClientPathToDebugger = (clientPath: string): string => {
      if (sourceFileMap) {
        for (const sourceFileMapSource of Object.keys(sourceFileMap)) {
          const sourceFileMapTarget = sourceFileMap[sourceFileMapSource]
          const resolvedSource = path.resolve(sourceFileMapSource)
          const resolvedClient = path.resolve(clientPath)
          const relativePath = path.relative(resolvedSource, resolvedClient)
          if (!relativePath.startsWith('..')) {
            // client is child of source
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
            // filename is child of target
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

  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): void {
    try {
      this._stopOnEntry = args.stopOnEntry
      this._stopOnError = args.stopOnError ?? false
      this.sendEvent(new DebugEvent('gmod.errors.clear'))

      const cwd = args.cwd ? args.cwd : process.cwd()
      const sourceRoot = args.sourceRoot ? args.sourceRoot : cwd

      this.setupSourceEnv(sourceRoot, args.sourceFileMap)
      this._sourceRoot = sourceRoot
      this.getControlService(args.realm, sourceRoot)

      const programArgs = args.args ? args.args : []

      // only using the shell seems to be able to run SRCDS without causing engine errors and removing all output from its window
      this._debug_server_process = spawn(args.program, programArgs, {
        cwd: cwd,
        shell: true,
        windowsHide: false,
      })

      const port = args.port ? args.port : 21111

      this._debug_client = new LRDBClient.Client(
        new LRDBAdapter.TcpAdapter(port, 'localhost')
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

      this._debug_client.onOpen.on(() => {
        this._serverInitCompleted = false
        const data = {
          protocol_version: GmodDebugSession.DEBUGGER_PROTOCOL_VERSION,
          stop_on_error: this._stopOnError,
        }
        this._debug_client?.init(data)
          .then(() => {
            this._serverInitCompleted = true
          })
          .catch((error) => {
            this.handleInitError(error)
          })
        this.sendEvent(new InitializedEvent())
      })

      this._debug_client.onTransportError.on((err) => {
        this._serverInitCompleted = false
        this.sendEvent(new OutputEvent(`Debugger transport error: ${err.message}. Waiting for server to reconnect...\n`))
      })

      this._debug_server_process.stdout?.on('data', (chunk: Buffer | string) => {
        const message = chunk.toString()
        if (message.length > 0) {
          this.sendEvent(new OutputEvent(message, 'stdout'))
        }
      })

      this._debug_server_process.stderr?.on('data', (chunk: Buffer | string) => {
        const message = chunk.toString()
        if (message.length > 0) {
          this.sendEvent(new OutputEvent(message, 'stderr'))
        }
      })

      this._debug_server_process.on('error', (error: Error) => {
        this.sendEvent(new OutputEvent(`${error.message}\n`, 'stderr'))
      })

      this._debug_server_process.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
        const category: 'stdout' | 'stderr' = code === 0 && !signal ? 'stdout' : 'stderr'
        this.sendEvent(new OutputEvent(`SRCDS process exited (${status}).\n`, category))
        this.sendEvent(new TerminatedEvent())
      })

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    args: AttachRequestArguments
  ): void {
    try {
      this._stopOnEntry = args.stopOnEntry
      this._stopOnError = args.stopOnError ?? false
      this.sendEvent(new DebugEvent('gmod.errors.clear'))

      this.setupSourceEnv(args.sourceRoot, args.sourceFileMap)
      this._sourceRoot = args.sourceRoot
      this.getControlService(args.realm, args.sourceRoot)

      const port = args.port ? args.port : 21111
      const host = args.host ? args.host : 'localhost'

      this.sendEvent(new OutputEvent(`Debugger connecting to ${host}:${port} ...\n`))
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
        this.sendEvent(new OutputEvent(`Debugger disconnected.\n`))
        this.sendEvent(new TerminatedEvent())
      })

      this._debug_client.onOpen.on(() => {
        this._serverInitCompleted = false
        this.sendEvent(new OutputEvent(`Debugger connected!\n`))
        const data = {
          protocol_version: GmodDebugSession.DEBUGGER_PROTOCOL_VERSION,
          stop_on_error: this._stopOnError,
        }
        this._debug_client?.init(data)
          .then(() => {
            this._serverInitCompleted = true
          })
          .catch((error) => {
            this.handleInitError(error)
          })
        this.sendEvent(new InitializedEvent())
      })

      this._debug_client.onTransportError.on((err) => {
        this._serverInitCompleted = false
        this.sendEvent(new OutputEvent(`Debugger transport error: ${err.message}. Waiting for server to reconnect...\n`))
      })

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse
  ): void {
    this._configurationDoneReceived = true
    this.sendResponse(response)
  }

  protected customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: any
  ): void {
    const entityRequest = this.resolveEntityRequest(command, args)
    if (entityRequest) {
      entityRequest
        .then((result) => {
          response.body = result as Record<string, unknown>
          this.sendResponse(response)
        })
        .catch((err) => {
          response.success = false
          response.message = this.toResponseErrorMessage(err)
          this.sendResponse(response)
        })
      return
    }

    const controlCommand = this.resolveControlCommand(command, args)
    if (!controlCommand) {
      super.customRequest(command, response, args)
      return
    }

    const controlArgs = command === 'gmod.control' && args ? args : { ...(args ?? {}) }
    if (controlArgs.command) {
      delete controlArgs.command
    }

    this.getControlService().execute(controlCommand, controlArgs)
      .then((result) => {
        this.emitControlResult(result)
        this.sendEvent(new DebugEvent('gmod.controlResult', result))
        response.body = result as unknown as Record<string, unknown>
        this.sendResponse(response)
      })
      .catch((err) => {
        response.success = false
        response.message = err instanceof Error ? err.message : String(err)
        this.sendEvent(new DebugEvent('gmod.controlError', {
          message: response.message,
          command: controlCommand,
        }))
        this.sendEvent(new OutputEvent(`Control command failed: ${response.message}\n`, 'stderr'))
        this.sendResponse(response)
      })
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    try {
      const path = args.source.path
      if (!this._debug_client || !path) {
        response.success = false
        this.sendResponse(response)
        return
      }

      // read file contents into array for direct access
      const lines = readFileSync(path).toString().split('\n')

      const breakpoints = new Array<DebugProtocol.Breakpoint>()

      const debuggerFilePath = this.convertClientPathToDebugger(path)

      this._debug_client.clearBreakPoints({ file: debuggerFilePath })
        .catch((err: Error) => {
          this.sendEvent(new OutputEvent(`Warning: failed to clear breakpoints for '${debuggerFilePath}': ${err.message}\n`, 'stderr'))
        })

      if (args.breakpoints) {
        // verify breakpoint locations
        for (const souceBreakpoint of args.breakpoints) {
          let l = this.convertClientLineToDebugger(souceBreakpoint.line)
          let verified = false
          const isLogPoint = !!souceBreakpoint.logMessage
          if (!isLogPoint) {
            while (l <= lines.length) {
              const line = lines[l - 1].trim()
              // if a line is empty or starts with '--' we don't allow to set a breakpoint but move the breakpoint down
              if (line.length == 0 || line.startsWith('--')) {
                l++
              } else {
                verified = true // this breakpoint has been validated
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
            bp.message = 'Logpoints are not supported by gluals_gmod; use a conditional breakpoint or evaluate instead.'
          }
          breakpoints.push(bp)
          if (verified) {
            const sendbreakpoint = {
              line: l,
              file: debuggerFilePath,
              condition: souceBreakpoint.condition,
              hit_condition: souceBreakpoint.hitCondition,
            }
            this._debug_client.addBreakPoint(sendbreakpoint)
              .catch((err: Error) => {
                this.sendEvent(new OutputEvent(`Failed to set breakpoint at '${debuggerFilePath}:${l}': ${err.message}\n`, 'stderr'))
              })
          }
        }
      }

      // send back the actual breakpoint positions
      response.body = {
        breakpoints: breakpoints,
      }

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    // return the default thread
    response.body = {
      threads: [new Thread(GmodDebugSession.THREAD_ID, 'thread 1')],
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
          const startFrame =
            typeof args.startFrame === 'number' ? args.startFrame : 0
          const maxLevels =
            typeof args.levels === 'number'
              ? args.levels
              : res.result.length - startFrame
          const endFrame = Math.min(startFrame + maxLevels, res.result.length)
          const frames = new Array<StackFrame>()
          for (let i = startFrame; i < endFrame; i++) {
            const frame = res.result[i] // use a word of the line as the stackframe name
            if(frame.file === undefined) frame.file = ""
            if(frame.func === undefined) frame.func = ""
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
      })
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
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
            params: {
              stack_no: args.frameId,
            },
          }),
          false
        ),
        new Scope(
          'Upvalues',
          this._variableHandles.create({
            type: 'get_upvalues',
            params: {
              stack_no: args.frameId,
            },
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

      response.body = {
        scopes: scopes,
      }

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
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
              return this._debug_client
                .getGlobal(parent.params)
                .then((res) => res.result)
            case 'get_local_variable':
              return this._debug_client
                .getLocalVariable(parent.params)
                .then((res) => res.result)
            case 'get_upvalues':
              return this._debug_client
                .getUpvalues(parent.params)
                .then((res) => res.result)
            case 'eval':
              return this._debug_client.eval(parent.params).then((res) => {
                const results = res.result as any[]
                return results[0]
              })
            default:
              return Promise.reject(Error('invalid'))
          }
        })()

        res
          .then((result) =>
            this.variablesRequestResponse(response, result, parent)
          )
          .catch((err) => {
            response.success = false
            response.message = err.message
            this.sendResponse(response)
          })
      } else {
        response.success = false
        this.sendResponse(response)
      }
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  private variablesRequestResponse(
    response: DebugProtocol.VariablesResponse,
    variablesData: unknown,
    parent: VariableReference
  ): void {
    try {
      const evalParam = (k: any): EvalParam => {
        switch (parent.type) {
          case 'eval': {
            const key = typeof k === 'string' ? `"${k}"` : `${k}`
            return {
              type: 'eval',
              params: {
                ...parent.params,
                chunk: `(${parent.params.chunk})[${key}]`,
              },
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
          const varRef =
            typename === 'object' ? this._variableHandles.create(evalParam(k)) : 0
          variables.push({
            name: `${k}`,
            type: typename,
            value: stringify_v2(v),
            variablesReference: varRef,
          })
        })
      } else if (typeof variablesData === 'object' && variablesData !== null) {
        const varData = variablesData as Record<string, any>
        for (const k in varData) {
          const typename = typeof varData[k]
          const varRef =
            typename === 'object' ? this._variableHandles.create(evalParam(k)) : 0
          variables.push({
            name: k,
            type: typename,
            value: stringify_v2(varData[k]),
            variablesReference: varRef,
          })
        }
      }

      response.body = {
        variables: variables,
      }

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
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
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    _args: DebugProtocol.NextArguments
  ): void {
    try {
      this._debug_client?.step()
      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    _args: DebugProtocol.StepInArguments
  ): void {
    try {
      this._debug_client?.stepIn()
      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    _args: DebugProtocol.StepOutArguments
  ): void {
    try {
      this._debug_client?.stepOut()
      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
    _args: DebugProtocol.PauseArguments
  ): void {
    try {
      this._debug_client?.pauseNow()
      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
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
        response.body = {
          content: id,
        }
      }

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments
  ): void {
    try {
      if (args.terminateDebuggee) {
        this.sendEvent(
          new OutputEvent(
            'terminateDebuggee is not supported by gluals_gmod; disconnecting debugger transport only.\n',
            'stderr'
          )
        )
      }

      if (this._debug_server_process) {
        if (this._debug_server_process.pid) {
          killProcess(this._debug_server_process.pid)
        }

        delete this._debug_server_process
      }

      if (this._debug_client) {
        this._debug_client.end()
        delete this._debug_client
      }

      this._serverInitCompleted = false
      this._configurationDoneReceived = false
      this._isPaused = false

      this.sendResponse(response)
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }

  protected setExpressionRequest(
    response: DebugProtocol.SetExpressionResponse,
    args: DebugProtocol.SetExpressionArguments
  ): void {
    response.success = false
    response.message =
      'setExpression is not supported by gluals_gmod because the LRDB protocol has no assignment/eval-set request.'
    response.body = {
      value: args.value,
      type: 'string',
      variablesReference: 0,
    }
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
        const explicitLuaPrefix = /^(lua|eval)\s+/i
        const explicitCommandPrefix = /^con\s+/i
        let command = expression
        let luaExpression: string | undefined
        const frameScopedEvaluation = this._isPaused && typeof args.frameId === 'number' && Number.isFinite(args.frameId)

        if (expression.startsWith('=')) {
          luaExpression = expression.slice(1).trim()
        } else if (explicitLuaPrefix.test(expression)) {
          luaExpression = expression.replace(explicitLuaPrefix, '').trim()
        } else if (explicitCommandPrefix.test(expression)) {
          command = expression.replace(explicitCommandPrefix, '').trim()
        } else if (frameScopedEvaluation) {
          // Preserve Evaluate-in-Debug-Console behavior for frame-bound expressions.
          luaExpression = expression
        }

        if (luaExpression != null) {
          if (luaExpression.length === 0) {
            response.success = false
            response.message = 'Lua expression is empty.'
            this.sendResponse(response)
            return
          }

          const requestParam: EvalRequest['params'] = {
            stack_no: args.frameId as number,
            chunk: luaExpression,
            depth: 0,
          }
          this._debug_client.eval(requestParam).then((res) => {
            if (res.result instanceof Array) {
              let ret = ''
              ret = res.result.map((v) => stringify_v2(v)).join('\t')
              let varRef = 0
              if (res.result.length == 1) {
                const refobj = res.result[0]
                const typename = typeof refobj
                if (refobj && typename == 'object') {
                  varRef = this._variableHandles.create({
                    type: 'eval',
                    params: requestParam,
                  })
                }
              }

              response.body = {
                result: ret,
                variablesReference: varRef,
              }
            } else {
              response.body = {
                result: '',
                variablesReference: 0,
              }

              response.success = false
            }

            this.sendResponse(response)
          })
          return
        }

        if (command.length === 0) {
          response.success = false
          response.message = 'Console command is empty.'
          this.sendResponse(response)
          return
        }

        const commandReadinessError = this.getConsoleCommandReadinessError()
        if (commandReadinessError) {
          response.success = false
          response.message = commandReadinessError
          this.sendEvent(new OutputEvent(`${commandReadinessError}\n`, 'console'))
          this.sendResponse(response)
          return
        }

        this.sendConsoleCommand(command)
          .then(() => {
            response.body = {
              result: `command: ${command}`,
              variablesReference: 0,
            }
            response.success = true
            this.sendResponse(response)
          })
          .catch((error) => {
            response.success = false
            response.message = error instanceof Error ? error.message : String(error)
            this.sendEvent(new OutputEvent(`Console command failed: ${response.message}\n`, 'stderr'))
            this.sendResponse(response)
          })
        return
      }

      const chunk = expression
      const requestParam: EvalRequest['params'] = {
        stack_no: args.frameId as number,
        chunk: chunk,
        depth: 0,
      }
      this._debug_client.eval(requestParam).then((res) => {
        if (res.result instanceof Array) {
          let ret = ''
          ret = res.result.map((v) => stringify_v2(v)).join('\t')
          let varRef = 0
          if (res.result.length == 1) {
            const refobj = res.result[0]
            const typename = typeof refobj
            if (refobj && typename == 'object') {
              varRef = this._variableHandles.create({
                type: 'eval',
                params: requestParam,
              })
            }
          }

          response.body = {
            result: ret,
            variablesReference: varRef,
          }
        } else {
          response.body = {
            result: '',
            variablesReference: 0,
          }

          response.success = false
        }

        this.sendResponse(response)
      })
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
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
            this.sendEvent(
              new StoppedEvent(
                event.params.reason,
                GmodDebugSession.THREAD_ID
              )
            )
          }

          break

        case 'running':
          this._isPaused = false
          this._variableHandles.reset()
          this.sendEvent(new ContinuedEvent(GmodDebugSession.THREAD_ID))
          break

        case 'exit':
          break

        case 'connected':
          this._debuggee_protocol_version = event.params.protocol_version
          this._debuggee_module_version = event.params.module_version
          this.sendEvent(new DebugEvent('gmod.connected', {
            protocolVersion: this._debuggee_protocol_version,
            moduleVersion: this._debuggee_module_version,
          }))
          this.sendEvent(
            new OutputEvent(
              `Debugger metadata: protocol=${this._debuggee_protocol_version ?? 'unknown'}, module=${this._debuggee_module_version ?? 'unknown'}\n`
            )
          )

          if (this._debuggee_module_version && this._debuggee_module_version !== GmodDebugSession.EXPECTED_GM_RDB_MODULE_VERSION) {
            this.sendEvent(new DebugEvent('gmod.rdb.versionMismatch', {
              moduleVersion: this._debuggee_module_version,
              expectedVersion: GmodDebugSession.EXPECTED_GM_RDB_MODULE_VERSION,
              protocolVersion: this._debuggee_protocol_version,
            }))
          }
          break

        case 'output':
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
            realm: this._controlService?.getRealm() ?? 'server',
          }))
          break

        case 'error':
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

          this.sendEvent(new OutputEvent(`[${source} error ${count}x] ${message}\n`, 'stderr'))
          this.sendEvent(new DebugEvent('gmod.error', {
            message,
            fingerprint,
            count,
            source,
            stackTrace,
          }))

          if (this._stopOnError) {
            this._debug_client?.pauseNow().catch((error) => {
              this.sendEvent(
                new OutputEvent(
                  `Failed to stop on error: ${error instanceof Error ? error.message : String(error)}\n`,
                  'stderr'
                )
              )
            })
          }
          break
      }
    } catch(e) {
      if (typeof e === "string") {
        this.sendEvent(new OutputEvent(`Debug Adapter exception: ${e}\n`))
      } else if (e instanceof Error) {
        this.sendEvent(new OutputEvent(e.message))
      }
    }
  }

  private resolveControlCommand(command: string, args: any): GmodControlCommand | undefined {
    if (command === 'gmod.control') {
      const nested = args && typeof args.command === 'string' ? args.command : ''
      if (GmodDebugSession.CONTROL_COMMANDS.has(nested as GmodControlCommand)) {
        return nested as GmodControlCommand
      }
      return undefined
    }

    if (GmodDebugSession.CONTROL_COMMANDS.has(command as GmodControlCommand)) {
      return command as GmodControlCommand
    }
    return undefined
  }

  private resolveEntityRequest(command: string, args: any): Promise<unknown> | undefined {
    switch (command) {
      case 'gmod.entity.getEntities':
        return this.handleGetEntitiesRequest(args)
      case 'gmod.entity.getEntity':
        return this.handleGetEntityRequest(args)
      case 'gmod.entity.getEntityNetworkVars':
        return this.handleGetEntityNetworkVarsRequest(args)
      case 'gmod.entity.getEntityTable':
        return this.handleGetEntityTableRequest(args)
      case 'gmod.entity.setTableValue':
        return this.handleSetEntityTableValueRequest(args)
      case 'gmod.entity.setNetworkVar':
        return this.handleSetEntityNetworkVarRequest(args)
      case 'gmod.entity.setProperty':
        return this.handleSetEntityPropertyRequest(args)
      default:
        return undefined
    }
  }

  private async handleGetEntitiesRequest(args: any): Promise<GetEntitiesResult> {
    const client = this.requireDebugClient()
    const response = await client.getEntities(this.coerceGetEntitiesParams(args))
    return response.result
  }

  private async handleGetEntityRequest(args: any): Promise<EntityDetail> {
    const client = this.requireDebugClient()
    const response = await client.getEntity({ index: this.coerceEntityIndex(args) })
    return response.result
  }

  private async handleGetEntityTableRequest(args: any): Promise<GetEntityTableResult> {
    const client = this.requireDebugClient()
    const response = await client.getEntityTable(this.coerceEntityTableParams(args))
    return response.result
  }

  private async handleGetEntityNetworkVarsRequest(args: any): Promise<GetEntityNetworkVarsResult> {
    const client = this.requireDebugClient()
    const response = await client.getEntityNetworkVars({ index: this.coerceEntityIndex(args) })
    return response.result
  }

  private async handleSetEntityNetworkVarRequest(
    args: any
  ): Promise<{ ok: boolean; index: number; name: string }> {
    const client = this.requireDebugClient()
    const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const index = this.coerceEntityIndex(raw)
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (name.length === 0) {
      throw new Error('NetworkVar name is required.')
    }

    const valueArgs = this.coerceEntityPropertyParams({
      index,
      property: name,
      value: raw.value,
    })

    const response = await client.setEntityNetworkVar({
      index: valueArgs.index,
      name,
      value: valueArgs.value,
    })
    return response.result
  }

  private async handleSetEntityTableValueRequest(
    args: any
  ): Promise<{ ok: boolean; index: number; property: string }> {
    const client = this.requireDebugClient()
    const params = this.coerceEntityPropertyParams(args)
    const response = await client.setEntityTableValue(params)
    return response.result
  }

  private async handleSetEntityPropertyRequest(
    args: any
  ): Promise<{ ok: boolean; index: number; property: string }> {
    const client = this.requireDebugClient()
    const response = await client.setEntityProperty(this.coerceEntityPropertyParams(args))
    return response.result
  }

  private requireDebugClient(): LRDBClient.Client {
    if (!this._debug_client) {
      throw new Error('Debugger is not connected.')
    }
    return this._debug_client
  }

  private coerceGetEntitiesParams(args: any): GetEntitiesParams {
    const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {}

    return {
      offset: this.coerceNonNegativeInteger(raw.offset, 0),
      limit: this.coerceNonNegativeInteger(raw.limit, 50),
      filter_id: this.coerceNonNegativeInteger(raw.filter_id, 0),
      filter_class: typeof raw.filter_class === 'string' ? raw.filter_class : '',
    }
  }

  private coerceEntityIndex(args: any): number {
    const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const index = typeof raw.index === 'number' && Number.isFinite(raw.index)
      ? Math.floor(raw.index)
      : -1
    if (index < 0) {
      throw new Error('Entity index must be a non-negative integer.')
    }
    return index
  }

  private coerceEntityPropertyParams(args: any): SetEntityPropertyParams {
    const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const index = typeof raw.index === 'number' && Number.isFinite(raw.index)
      ? Math.floor(raw.index)
      : -1
    if (index < 0) {
      throw new Error('Entity index must be a non-negative integer.')
    }

    const property = typeof raw.property === 'string' ? raw.property.trim() : ''
    if (property.length === 0) {
      throw new Error('Entity property name is required.')
    }

    const value = raw.value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { index, property, value }
    }

    if (Array.isArray(value) && value.length === 3) {
      const vector = value.map((entry) => Number(entry))
      if (vector.every((entry) => Number.isFinite(entry))) {
        return {
          index,
          property,
          value: [vector[0], vector[1], vector[2]],
        }
      }
    }

    throw new Error('Entity property value must be a string, number, boolean, or [x, y, z] vector.')
  }

  private coerceEntityTableParams(args: any): { index: number; filter?: string } {
    const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const index = typeof raw.index === 'number' && Number.isFinite(raw.index)
      ? Math.floor(raw.index)
      : -1
    if (index < 0) {
      throw new Error('Entity index must be a non-negative integer.')
    }

    const filter = typeof raw.filter === 'string' ? raw.filter.trim() : ''
    return filter.length > 0
      ? { index, filter }
      : { index }
  }

  private coerceNonNegativeInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback
    }
    return Math.max(0, Math.floor(value))
  }

  private toResponseErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  }

  private handleInitError(error: unknown): void {
    const serverProtocolVersion = this.extractServerProtocolVersion(error)
    if (serverProtocolVersion) {
      this.sendEvent(
        new OutputEvent(
          `Debugger protocol mismatch: client=${GmodDebugSession.DEBUGGER_PROTOCOL_VERSION}, server=${serverProtocolVersion}. Update gm_rdb or the VS Code extension so versions match.\n`,
          'stderr'
        )
      )
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    this.sendEvent(new OutputEvent(`Debugger init failed: ${message}\n`, 'stderr'))
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
      if (typeof error === 'string') {
        return error
      }
      if (error instanceof Error) {
        return error.message
      }
      return undefined
    })()

    if (typeof errorMessage === 'string') {
      const trimmed = errorMessage.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed)
          candidates.push(parsed)
          if (parsed && typeof parsed === 'object' && 'data' in parsed) {
            candidates.push((parsed as Record<string, unknown>).data)
          }
        } catch (_error) {
          // Ignore non-JSON errors and fall through to generic init failure output.
        }
      }
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') {
        continue
      }
      const version = (candidate as Record<string, unknown>).server_protocol_version
      if (typeof version === 'string' && version.trim().length > 0) {
        return version.trim()
      }
    }

    return undefined
  }

  private parseGmodErrorStackTrace(rawMessage: string): string[] {
    if (rawMessage.trim().length === 0) {
      return []
    }

    const frames: string[] = []
    const lines = rawMessage.split(/\r?\n/)
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.length === 0) {
        continue
      }
      if (line === '[ERROR]' || /^stack traceback:\s*$/i.test(line)) {
        continue
      }
      if (/^\d+\.\s+/.test(line)) {
        frames.push(line)
      }
    }

    return frames
  }

  private getControlService(initialRealm?: GmodRealm, sourceRoot?: string): GmodDebugControlService {
    const realm = initialRealm != null ? normalizeGmodRealm(initialRealm) : undefined
    if (!this._controlService) {
      this._controlService = new GmodDebugControlService(
        {
          pauseSoft: () => {
            if (!this._debug_client) {
              throw new Error('Debugger is not connected.')
            }
            return this._debug_client.pauseSoft()
          },
          pauseNow: () => {
            if (!this._debug_client) {
              throw new Error('Debugger is not connected.')
            }
            return this._debug_client.pauseNow()
          },
          resume: () => {
            if (!this._debug_client) {
              throw new Error('Debugger is not connected.')
            }
            return this._debug_client.continue()
          },
          runCommand: (command: string) => {
            return this.sendConsoleCommand(command)
          },
        },
        realm ?? 'server',
        sourceRoot ?? this._sourceRoot
      )
    } else {
      if (realm) {
        this._controlService.setRealm(realm)
      }
      this._controlService.setWorkspaceRoot(sourceRoot ?? this._sourceRoot)
    }
    return this._controlService
  }

  private emitControlResult(result: GmodControlResult): void {
    const header = `[control:${result.correlationId}] ${result.command} realm=${result.realm}`
    this.sendEvent(new OutputEvent(`${header}\n`, 'console'))
    if (result.request) {
      this.sendEvent(new OutputEvent(`[control:${result.correlationId}] request: ${result.request}\n`, 'console'))
    }
    for (const diagnostic of result.diagnostics) {
      const category = diagnostic.level === 'error' ? 'stderr' : 'console'
      this.sendEvent(
        new OutputEvent(
          `[control:${result.correlationId}] ${diagnostic.level.toUpperCase()}: ${diagnostic.message}\n`,
          category
        )
      )
    }
  }

  private getConsoleCommandReadinessError(): string | undefined {
    if (!this._debug_client) {
      return 'Debugger is not connected.'
    }

    if (!this._configurationDoneReceived) {
      return 'Debugger setup is not complete yet. Try again in a moment.'
    }

    if (!this._serverInitCompleted) {
      return 'Server not ready yet - command will be available after startup.'
    }

    return undefined
  }

  private sendConsoleCommand(command: string): Promise<void> {
    const commandReadinessError = this.getConsoleCommandReadinessError()
    if (commandReadinessError) {
      return Promise.reject(new Error(commandReadinessError))
    }

    if (!this._debug_client) {
      return Promise.reject(new Error('Debugger is not connected.'))
    }

    return this._debug_client.command(command).then(() => undefined)
  }

  protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void {
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
        if(parent.type === 'get_local_variable') {
          varScope = 'local'
          let lp = parent.params as GetLocalVariableRequest['params']
          if(lp.stack_no)  stackNo = lp.stack_no
        } else if(parent.type === 'get_upvalues') {
          varScope = 'up'
          let lp = parent.params as GetUpvaluesRequest['params']
          if(lp.stack_no)  stackNo = lp.stack_no
        } else if(parent.type === 'get_global') {
          varScope = 'global'
        }

      }

      let value: string | number | boolean = args.value;
      if(value === 'true') {
        value = true
      } else if(value === 'false') {
        value = false
      }
      if(typeof value === 'string' && String(Number(value)) === value) {
        value = Number(value)
      }


      const params: SetVarRequest['params'] = {
        name: args.name,
        value: value,
        scope: varScope,
        stackNo: stackNo
      }
      this._debug_client.setVar(params).then((res) => {
        response.success = res.result
        if(response.success) {
          const body: DebugProtocol.SetVariableResponse['body'] = {
            value: args.value
          }
          response.body = body
        }
        this.sendResponse(response)
      })
    } catch(e) {
      response.success = false
      if (typeof e === "string") {
        response.message = `Debug Adapter exception: ${e}`
      } else if (e instanceof Error) {
        response.message = `Debug Adapter exception: ${e.message}`
      }
      this.sendEvent(new OutputEvent(response.message + "\n"))
      this.sendResponse(response)
    }
  }
}
