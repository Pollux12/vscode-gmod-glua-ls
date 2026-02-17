import {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  ContinuedEvent,
  StoppedEvent,
  OutputEvent,
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
  EvalRequest,
  ExitNotify,
  GetGlobalRequest,
  GetLocalVariableRequest,
  GetUpvaluesRequest,
  PausedNotify,
  RunningNotify,
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
  realm?: GmodRealm
}

export interface AttachRequestArguments
  extends DebugProtocol.AttachRequestArguments {
  host?: string
  port?: number
  sourceRoot: string
  sourceFileMap?: Record<string, string>
  stopOnEntry?: boolean
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

function getStringifiableObject(value: any): any {
  if (value == null) {
    return 'nil'
  } else if (value == undefined) {
    return 'none'
  } else if (typeof value === 'string') { // prevent putting quotes around the value
    return value
  } else if ((value instanceof Array)) {
    const newArr: Array<any> = []
    for (let i = 0; i < value.length; i++){
      newArr.push(getStringifiableObject(value[i]))
    }
    return newArr
  } else if (typeof value === 'object') {
    const newObj: any = {}
    const arrData = value['key']
    for (let i = 0; i < arrData.length - 1; i += 2){
      newObj[stringify_v3(arrData[i])] = getStringifiableObject(arrData[i + 1])
    }
    return newObj
  } else {
    return JSON.stringify(value)
  }
}

// protocol_version 2
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

// protocol_version 3
function stringify_v3(value: unknown): string {
  if (value == null) {
    return 'nil'
  } else if (value == undefined) {
    return 'none'
  } else if (typeof value === 'string') { // prevent putting quotes around the value
    return value
  } else if (typeof value === 'object') {
    return JSON.stringify(getStringifiableObject(value))
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

  private static DEBUGGER_PROTOCOL_VERSION = 'gmod-1'
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

  private _debuggee_protocol_version?: string
  private _controlService?: GmodDebugControlService
  private _sourceRoot?: string

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

    if (response.body) {
      response.body.supportsConfigurationDoneRequest = true
      response.body.supportsFunctionBreakpoints = true
      response.body.supportsConditionalBreakpoints = true
      response.body.supportsHitConditionalBreakpoints = true
      response.body.supportsEvaluateForHovers = true
      response.body.supportsSetVariable = false
    }

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
        windowsHide: true,
      })

      const port = args.port ? args.port : 21111

      this._debug_client = new LRDBClient.Client(
        new LRDBAdapter.TcpAdapter(port, 'localhost')
      )

      this._debug_client.onNotify.on((event) => {
        this.handleServerEvents(event as DebuggerNotify)
      })

      this._debug_client.onOpen.on(() => {
        const data = {
          protocol_version: GmodDebugSession.DEBUGGER_PROTOCOL_VERSION,
        }
        this._debug_client?.init(data)
        this.sendEvent(new InitializedEvent())
      })

      this._debug_client.onError.on((err) => {
        this.sendEvent(new OutputEvent(`Debugger communication error: ${err.message}\n`))
      })

      this._debug_server_process.on('error', (msg: string) => {
        this.sendEvent(new OutputEvent(msg, 'error'))
      })

      this._debug_server_process.on('close', (code: number) => {
        this.sendEvent(new OutputEvent(`exit status: ${code}\n`))
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
        this.handleServerEvents(event as DebuggerNotify)
      })

      this._debug_client.onClose.on(() => {
        this.sendEvent(new OutputEvent(`Debugger disconnected.\n`))
        this.sendEvent(new TerminatedEvent())
      })

      this._debug_client.onOpen.on(() => {
        this.sendEvent(new OutputEvent(`Debugger connected!\n`))
        const data = {
          protocol_version: GmodDebugSession.DEBUGGER_PROTOCOL_VERSION,
        }
        this._debug_client?.init(data)
        this.sendEvent(new InitializedEvent())
      })

      this._debug_client.onError.on((err) => {
        this.sendEvent(new OutputEvent(`Debugger communication error: ${err.message}\n`))
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
    this.sendResponse(response)
  }

  protected customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: any
  ): void {
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
        response.body = result as unknown as Record<string, unknown>
        this.sendResponse(response)
      })
      .catch((err) => {
        response.success = false
        response.message = err instanceof Error ? err.message : String(err)
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

      if (args.breakpoints) {
        // verify breakpoint locations
        for (const souceBreakpoint of args.breakpoints) {
          let l = this.convertClientLineToDebugger(souceBreakpoint.line)
          let verified = false
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

          const bp: DebugProtocol.Breakpoint = new Breakpoint(
            verified,
            this.convertDebuggerLineToClient(l)
          )
          bp.id = this._breakPointID++
          breakpoints.push(bp)
          if (verified) {
            const sendbreakpoint = {
              line: l,
              file: debuggerFilePath,
              condition: souceBreakpoint.condition,
              hit_condition: souceBreakpoint.hitCondition,
            }
            this._debug_client.addBreakPoint(sendbreakpoint)
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
        if (this._debuggee_protocol_version === '2') {
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
        } else {
          variablesData.forEach((v, i) => {
            const typename = typeof v
            const k = i + 1
            const varRef =
              typename === 'object' ? this._variableHandles.create(evalParam(k)) : 0
            variables.push({
              name: `${k}`,
              type: typename,
              value: stringify_v3(v),
              variablesReference: varRef,
            })
          })
        }
      }
      else if (typeof variablesData === 'object') {
        if (this._debuggee_protocol_version === '2') {
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
        } else {
          if (variablesData !== null && variablesData !== undefined && 'key' in variablesData) {
            const arrData = (variablesData as {key: Array<object>}).key

            for (let i = 0; i < arrData.length - 1; i += 2){
              const key = arrData[i]
              const val = arrData[i + 1]

              const typename = typeof val
              const varRef = typename === 'object' ? this._variableHandles.create(evalParam(key)) : 0
              variables.push({
                name: `${key}`,
                type: typename,
                value: stringify_v3(val),
                variablesReference: varRef,
              })
            }
          }
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
    _args: DebugProtocol.DisconnectArguments
  ): void {
    try {
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

      if (args.context === 'repl' && args.expression.startsWith('con ')) {
        this._debug_client.command(args.expression.substr(4) + '\n')
        response.success = true
        this.sendResponse(response)
        return
      }

      const chunk = args.expression
      const requestParam: EvalRequest['params'] = {
        stack_no: args.frameId as number,
        chunk: chunk,
        depth: 0,
      }
      this._debug_client.eval(requestParam).then((res) => {
        if (res.result instanceof Array) {
          let ret = ''
          if (this._debuggee_protocol_version === '2') {
              ret = res.result.map((v) => stringify_v2(v)).join('\t')
          } else {
              ret = res.result.map((v) => stringify_v3(v)).join('\t')
          }
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
            this._debug_client?.continue()
          } else {
            this.sendEvent(
              new StoppedEvent(
                event.params.reason,
                GmodDebugSession.THREAD_ID
              )
            )
          }

          break

        case 'running':
          this._variableHandles.reset()
          this.sendEvent(new ContinuedEvent(GmodDebugSession.THREAD_ID))
          break

        case 'exit':
          break

        case 'connected':
          this._debuggee_protocol_version = event.params.protocol_version
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
            if (!this._debug_client) {
              throw new Error('Debugger is not connected.')
            }
            return this._debug_client.command(command)
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
