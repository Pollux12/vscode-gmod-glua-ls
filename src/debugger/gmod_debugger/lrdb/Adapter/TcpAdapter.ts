import { isJsonRpcMessage, JsonRpcMessage } from '../JsonRpc'
import { DebugRequest, DebugClientAdapter } from '../Client'
import { TypedEventEmitter } from '../TypedEventEmitter'
import * as net from 'net'
import * as readline from 'readline'

export interface TcpAdapterOptions {
  maxReconnectAttempts?: number
}

export class TcpAdapter implements DebugClientAdapter {
  private _connection?: net.Socket
  private _readline?: readline.Interface
  private readonly _port: number
  private readonly _host: string
  private readonly _maxReconnectAttempts: number
  private _disposed = false
  private _connected = false
  private _closeEmitted = false
  private _reconnectAttempts = 0
  private _reconnectTimer?: NodeJS.Timeout
  private _connectionGeneration = 0
  private _reconnectScheduledForGeneration = false
  onMessage: TypedEventEmitter<JsonRpcMessage> = new TypedEventEmitter<JsonRpcMessage>()
  public constructor(port: number, host: string, options: TcpAdapterOptions = {}) {
    this._port = port
    this._host = host
    this._maxReconnectAttempts =
      typeof options.maxReconnectAttempts === 'number' && Number.isFinite(options.maxReconnectAttempts)
        ? Math.max(1, Math.floor(options.maxReconnectAttempts))
        : 5
    this.connect()
  }

  private connect(): void {
    if (this._disposed) {
      return
    }

    this.disposeStaleConnection()
    const connection = net.connect(this._port, this._host)
    const generation = ++this._connectionGeneration
    this._reconnectScheduledForGeneration = false
    this._connection = connection

    const rl = readline.createInterface({
      input: connection,
    })
    this._readline = rl

    connection.on('connect', () => {
      if (generation !== this._connectionGeneration || this._disposed) {
        return
      }
      this._connected = true
      this._reconnectAttempts = 0
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = undefined
      }
      this.onOpen.emit()
    })

    connection.on('close', () => {
      if (generation !== this._connectionGeneration) {
        return
      }
      this._connected = false
      if (this._readline === rl) {
        rl.close()
        this._readline = undefined
      }

      if (this._disposed) {
        this.emitCloseOnce()
        return
      }

      this.onError.emit(
        new Error(`Debugger transport closed, reconnecting to ${this._host}:${this._port}`)
      )

      this.scheduleReconnectForCurrentGeneration(generation)
    })

    connection.on('error', (err: Error) => {
      if (generation !== this._connectionGeneration || this._disposed) {
        return
      }
      this.onError.emit(err)
      this.scheduleReconnectForCurrentGeneration(generation)
    })

    rl.on('line', (input: string) => {
      if (generation !== this._connectionGeneration || this._disposed) {
        return
      }
      try {
        const message = JSON.parse(input)
        if (isJsonRpcMessage(message)) {
          this.onMessage.emit(message)
        } else {
          this.onError.emit(new Error(`Invalid JSON-RPC message: ${input}`))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.onError.emit(new Error(`Failed to parse JSON-RPC message: ${message}`))
      }
    })
  }

  private disposeStaleConnection(): void {
    if (this._readline) {
      this._readline.close()
      this._readline = undefined
    }
    if (this._connection) {
      this._connection.removeAllListeners()
      if (!this._connection.destroyed) {
        this._connection.destroy()
      }
      this._connection = undefined
    }
    this._connected = false
  }

  private scheduleReconnectForCurrentGeneration(generation: number): void {
    if (generation !== this._connectionGeneration || this._reconnectScheduledForGeneration) {
      return
    }
    this._reconnectScheduledForGeneration = true
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this._disposed || this._connected || this._reconnectTimer) {
      return
    }

    this._reconnectAttempts += 1
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._disposed = true
      this.disposeStaleConnection()
      this.emitCloseOnce()
      return
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined
      this.connect()
    }, 1000)
  }

  private emitCloseOnce(): void {
    if (this._closeEmitted) {
      return
    }
    this._closeEmitted = true
    this.onClose.emit()
  }

  send(request: DebugRequest): boolean {
    if (!this._connection || !this._connected) {
      return false
    }
    return this._connection.write(`${JSON.stringify(request)}\n`)
  }

  end(): void {
    this._disposed = true
    this._reconnectScheduledForGeneration = false
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = undefined
    }

    if (this._readline) {
      this._readline.close()
      this._readline = undefined
    }

    if (this._connection && !this._connection.destroyed) {
      this._connection.end()
      return
    }
    this.emitCloseOnce()
  }
  onClose: TypedEventEmitter<void> = new TypedEventEmitter<void>()
  onOpen: TypedEventEmitter<void> = new TypedEventEmitter<void>()
  onError: TypedEventEmitter<Error> = new TypedEventEmitter<Error>()
}
