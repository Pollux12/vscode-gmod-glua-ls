import { isJsonRpcMessage, JsonRpcMessage } from '../JsonRpc'
import { DebugRequest, DebugClientAdapter } from '../Client'
import { TypedEventEmitter } from '../TypedEventEmitter'
import * as net from 'net'
import * as readline from 'readline'

export class TcpAdapter implements DebugClientAdapter {
  private _connection: net.Socket
  onMessage: TypedEventEmitter<JsonRpcMessage> = new TypedEventEmitter<JsonRpcMessage>()
  public constructor(port: number, host: string) {
    const connection = net.connect(port, host)
    this._connection = connection

    connection.on('connect', () => {
      this.onOpen.emit()
    })

    connection.on('close', () => {
      this.onClose.emit()
    })

    connection.on('error', (err: Error) => {
      this.onError.emit(err)
    })

    const rl = readline.createInterface({
      input: connection,
    })

    rl.on('line', (input: string) => {
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
  send(request: DebugRequest): boolean {
    return this._connection.write(`${JSON.stringify(request)}\n`)
  }
  end(): void {
    this._connection.end()
  }
  onClose: TypedEventEmitter<void> = new TypedEventEmitter<void>()
  onOpen: TypedEventEmitter<void> = new TypedEventEmitter<void>()
  onError: TypedEventEmitter<Error> = new TypedEventEmitter<Error>()
}
