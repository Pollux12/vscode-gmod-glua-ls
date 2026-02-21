import { TypedEventTarget, TypedEventEmitter } from './TypedEventEmitter'
import {
  JsonRpcNotify,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcMessage,
  isJsonRpcNotify,
  isJsonRpcResponse,
} from './JsonRpc'

export type DebugRequest =
  | InitRequest
  | StepRequest
  | StepInRequest
  | StepOutRequest
  | ContinueRequest
  | PauseRequest
  | PauseNowRequest
  | AddBreakPointRequest
  | GetBreakPointsRequest
  | ClearBreakPointsRequest
  | GetStackTraceRequest
  | GetLocalVariableRequest
  | GetUpvaluesRequest
  | EvalRequest
  | GetGlobalRequest
  | SetVarRequest
  | CommandRequest
  | GetEntitiesRequest
  | GetEntityRequest
  | SetEntityPropertyRequest

export interface DebugClientAdapter {
  onMessage: TypedEventTarget<JsonRpcMessage>
  onOpen: TypedEventTarget<void>
  onClose: TypedEventTarget<void>
  onError: TypedEventTarget<Error>
  send(request: DebugRequest): boolean
  end(): void
}

export class Client {
  private seqId = 0
  private currentStatus_?: RunningStatus
  constructor(private adapter: DebugClientAdapter) {
    adapter.onMessage.on((msg) => {
      if (isJsonRpcNotify(msg)) {
        const notify = msg as DebuggerNotify
        this.currentStatus_ = notify.method
        this.onNotify.emit(notify)
      }
    })

    this.onClose = adapter.onClose
    this.onOpen = adapter.onOpen
    this.onTransportError = adapter.onError
  }
  get currentStatus(): RunningStatus | undefined {
    return this.currentStatus_
  }
  send<T extends DebugRequest>(request: T): Promise<DebugResponseType<T>> {
    const { onMessage, onError } = this.adapter
    return new Promise<DebugResponseType<T>>((resolve, reject) => {
      const onReceiveMessage = (msg: JsonRpcMessage) => {
        if (isJsonRpcResponse(msg)) {
          if (request.id === msg.id) {
            if (msg.error) {
              reject(Error(JSON.stringify(msg.error)))
            } else {
              resolve(msg as DebugResponseType<T>)
            }
            onMessage.off(onReceiveMessage)
            onError.off(onReceiveError)
          }
        }
      }
      const onReceiveError = (err: Error) => {
        reject(err)
        onMessage.off(onReceiveMessage)
        onError.off(onReceiveError)
      }

      const ret = this.adapter.send(request)
      if (ret) {
        onMessage.on(onReceiveMessage)
        onError.on(onReceiveError)
      } else {
        reject(Error('Send error'))
      }
    })
  }

  init = (
    params: InitRequest['params']
  ): Promise<DebugResponseType<InitRequest>> =>
    this.send({
      method: 'init',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })

  step = (): Promise<DebugResponseType<StepRequest>> =>
    this.send({ method: 'step', jsonrpc: '2.0', id: this.seqId++ })
  stepIn = (): Promise<DebugResponseType<StepInRequest>> =>
    this.send({ method: 'step_in', jsonrpc: '2.0', id: this.seqId++ })
  stepOut = (): Promise<DebugResponseType<StepOutRequest>> =>
    this.send({ method: 'step_out', jsonrpc: '2.0', id: this.seqId++ })
  continue = (): Promise<DebugResponseType<ContinueRequest>> =>
    this.send({ method: 'continue', jsonrpc: '2.0', id: this.seqId++ })
  pause = (): Promise<DebugResponseType<PauseRequest>> =>
    this.send({ method: 'pause', jsonrpc: '2.0', id: this.seqId++ })
  pauseSoft = (): Promise<DebugResponseType<PauseRequest>> =>
    this.send({ method: 'pause', jsonrpc: '2.0', id: this.seqId++ })
  pauseNow = (): Promise<DebugResponseType<PauseNowRequest>> =>
    this.send({ method: 'pause_now', jsonrpc: '2.0', id: this.seqId++ })

  addBreakPoint = (
    params: AddBreakPointRequest['params']
  ): Promise<DebugResponseType<AddBreakPointRequest>> =>
    this.send({
      method: 'add_breakpoint',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  getBreakPoints = (): Promise<DebugResponseType<GetBreakPointsRequest>> =>
    this.send({
      method: 'get_breakpoints',
      jsonrpc: '2.0',
      id: this.seqId++,
    })
  clearBreakPoints = (
    params: ClearBreakPointsRequest['params']
  ): Promise<DebugResponseType<ClearBreakPointsRequest>> =>
    this.send({
      method: 'clear_breakpoints',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  getStackTrace = (): Promise<DebugResponseType<GetStackTraceRequest>> =>
    this.send({
      method: 'get_stacktrace',
      jsonrpc: '2.0',
      id: this.seqId++,
    })
  getLocalVariable = (
    params: GetLocalVariableRequest['params']
  ): Promise<DebugResponseType<GetLocalVariableRequest>> =>
    this.send({
      method: 'get_local_variable',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  getUpvalues = (
    params: GetUpvaluesRequest['params']
  ): Promise<DebugResponseType<GetUpvaluesRequest>> =>
    this.send({
      method: 'get_upvalues',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  eval = (
    params: EvalRequest['params']
  ): Promise<DebugResponseType<EvalRequest>> =>
    this.send({
      method: 'eval',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  setVar = (
    params: SetVarRequest['params']
  ): Promise<DebugResponseType<SetVarRequest>> =>
    this.send({
      method: 'set_var',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  getGlobal = (
    params: GetGlobalRequest['params']
  ): Promise<DebugResponseType<GetGlobalRequest>> =>
    this.send({
      method: 'get_global',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })
  command = (
    params: CommandRequest['params']
  ): Promise<DebugResponseType<CommandRequest>> =>
    this.send({
      method: 'command',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })

  getEntities = (
    params: GetEntitiesRequest['params']
  ): Promise<DebugResponseType<GetEntitiesRequest>> =>
    this.send({
      method: 'get_entities',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })

  getEntity = (
    params: GetEntityRequest['params']
  ): Promise<DebugResponseType<GetEntityRequest>> =>
    this.send({
      method: 'get_entity',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })

  setEntityProperty = (
    params: SetEntityPropertyRequest['params']
  ): Promise<DebugResponseType<SetEntityPropertyRequest>> =>
    this.send({
      method: 'set_entity_property',
      jsonrpc: '2.0',
      id: this.seqId++,
      params,
    })

  end(): void {
    this.adapter.end()
  }

  onError(callback: (notify: GmodErrorNotify) => void): () => void {
    const notifyHandler = (notify: DebuggerNotify) => {
      if (notify.method === 'error') {
        callback(notify)
      }
    }

    this.onNotify.on(notifyHandler)
    return () => this.onNotify.off(notifyHandler)
  }

  onNotify: TypedEventEmitter<DebuggerNotify> = new TypedEventEmitter<DebuggerNotify>()
  onClose: TypedEventTarget<void>
  onOpen: TypedEventTarget<void>
  onTransportError: TypedEventTarget<Error>
}

export type DebugResponse = JsonRpcResponse
export type DebuggerNotify =
  | PausedNotify
  | ConnectedNotify
  | ExitNotify
  | RunningNotify
  | GmodErrorNotify

export type RunningStatus = DebuggerNotify['method']

export interface PausedNotify extends JsonRpcNotify {
  method: 'paused'
  params: {
    reason: 'breakpoint' | 'step' | 'step_in' | 'step_out' | 'pause' | 'entry'
  }
}
export interface ConnectedNotify extends JsonRpcNotify {
  method: 'connected'
  params?: {
    protocol_version?: string
    module_version?: string
  }
}
export interface ExitNotify extends JsonRpcNotify {
  method: 'exit'
  params?: never
}
export interface RunningNotify extends JsonRpcNotify {
  method: 'running'
  params?: never
}

export interface GmodErrorNotify extends JsonRpcNotify {
  method: 'error'
  params: {
    message: string
    fingerprint: string
    count: number
    source: 'lua' | 'console'
  }
}

export interface InitRequest extends JsonRpcRequest {
  method: 'init'
  params: {
    protocol_version: string
  }
}
interface StepRequest extends JsonRpcRequest {
  method: 'step'
  params?: never
}
interface StepInRequest extends JsonRpcRequest {
  method: 'step_in'
  params?: never
}
export interface StepOutRequest extends JsonRpcRequest {
  method: 'step_out'
  params?: never
}
export interface ContinueRequest extends JsonRpcRequest {
  method: 'continue'
  params?: never
}
export interface PauseRequest extends JsonRpcRequest {
  method: 'pause'
  params?: never
}
export interface PauseNowRequest extends JsonRpcRequest {
  method: 'pause_now'
  params?: never
}
export interface AddBreakPointRequest extends JsonRpcRequest {
  method: 'add_breakpoint'
  params: {
    line: number
    file: string
    condition?: string
    hit_condition?: string
  }
}
export interface GetBreakPointsRequest extends JsonRpcRequest {
  method: 'get_breakpoints'
  params?: never
}

export interface ClearBreakPointsRequest extends JsonRpcRequest {
  method: 'clear_breakpoints'
  params: {
    file: string
  }
}
export interface GetStackTraceRequest extends JsonRpcRequest {
  method: 'get_stacktrace'
  params?: never
}
export interface GetLocalVariableRequest extends JsonRpcRequest {
  method: 'get_local_variable'
  params: {
    stack_no: number
    depth?: number
  }
}
export interface GetUpvaluesRequest extends JsonRpcRequest {
  method: 'get_upvalues'
  params: {
    stack_no: number
    depth?: number
  }
}
export interface EvalRequest extends JsonRpcRequest {
  method: 'eval'
  params: {
    chunk: string
    stack_no: number
    depth?: number
    global?: boolean
    local?: boolean
    upvalue?: boolean
  }
}
export interface SetVarRequest extends JsonRpcRequest {
  method: 'set_var'
  params: {
    scope: string
    stackNo: number
    name: string
    value: number | string | boolean
  }
}
export interface GetGlobalRequest extends JsonRpcRequest {
  method: 'get_global'
  params?: {
    depth?: number
  }
}
export interface CommandRequest extends JsonRpcRequest {
  method: 'command'
  params: string
}

export type Vec3 = [number, number, number]

export interface EntitySummary {
  index: number
  class: string
  model: string
  valid: boolean
  pos: Vec3
  angles: Vec3
}

export interface EntityDetail {
  index: number
  class: string
  model: string
  valid: boolean
  pos: Vec3
  angles: Vec3
  parent_index: number | null
  health: number
  properties: Record<string, string | number | boolean>
}

export interface GetEntitiesParams {
  offset: number
  limit: number
  filter_id: number
  filter_class: string
}

export interface GetEntitiesResult {
  entities: EntitySummary[]
  total: number
  offset: number
  limit: number
}

export type SetEntityPropertyValue = string | number | boolean | Vec3

export interface SetEntityPropertyParams {
  index: number
  property: string
  value: SetEntityPropertyValue
}

export interface GetEntitiesRequest extends JsonRpcRequest {
  method: 'get_entities'
  params: GetEntitiesParams
}

export interface GetEntityRequest extends JsonRpcRequest {
  method: 'get_entity'
  params: {
    index: number
  }
}

export interface SetEntityPropertyRequest extends JsonRpcRequest {
  method: 'set_entity_property'
  params: SetEntityPropertyParams
}

type StackInfo = {
  file: string
  func: string
  line: number
  id: string
}

type Breakpoint = {
  line: number
  func?: string
  file: string
  condition?: string
  hit_count: number
}

type ResponseResultType = {
  init: never
  get_stacktrace: StackInfo[]
  get_local_variable: Record<string, unknown>
  get_upvalues: Record<string, unknown>
  eval: unknown
  get_global: Record<string, unknown>
  step: never
  step_in: never
  step_out: never
  continue: never
  pause: never
  pause_now: never
  add_breakpoint: never
  get_breakpoints: Breakpoint[]
  clear_breakpoints: never
  set_var: boolean
  command: never
  get_entities: GetEntitiesResult
  get_entity: EntityDetail
  set_entity_property: {
    ok: boolean
    index: number
    property: string
  }
}

export type DebugResponseType<T extends DebugRequest> = Pick<T, 'id'> & {
  result: ResponseResultType[T['method']]
}
