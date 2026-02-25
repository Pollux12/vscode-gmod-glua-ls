import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const { GmodDebugSession } = require('../out/debugger/gmod_debugger/GmodDebugSession')

class HarnessSession extends GmodDebugSession {
  constructor() {
    super()
    this.responses = []
    this.waiters = []
    this.outputs = []
  }

  sendResponse(response) {
    const snapshot = JSON.parse(JSON.stringify(response))
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(snapshot)
    } else {
      this.responses.push(snapshot)
    }
  }

  sendEvent(event) {
    if (event && event.body && typeof event.body.output === 'string') {
      this.outputs.push(event.body.output)
    }
  }

  nextResponse() {
    if (this.responses.length > 0) {
      return Promise.resolve(this.responses.shift())
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

function makeResponse(command) {
  return {
    seq: 1,
    type: 'response',
    request_seq: 1,
    command,
    success: true,
    body: {},
  }
}

async function run() {
  const fixturePath = path.resolve(__dirname, '../src/debugger/gmod_debugger/fixtures/parity-capabilities.json')
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  assert(Array.isArray(fixture.mandatoryParityScenarios), 'mandatoryParityScenarios fixture is missing')

  const expectedScenarios = [
    'initializeCapabilities',
    'setExpressionUnsupported',
    'terminateDebuggeeUnsupported',
    'logpointUnsupported',
    'setVariableRoundTrip',
  ]
  assert.deepStrictEqual(fixture.mandatoryParityScenarios, expectedScenarios)
  assert.strictEqual(fixture.connectedPayload.protocol_version, 'gmod-2')
  assert.match(fixture.connectedPayload.module_version, /^\d+\.\d+\.\d+$|^X\.Y\.Z$/)

  const session = new HarnessSession()

  const initializeResponse = makeResponse('initialize')
  session.initializeRequest(initializeResponse, {})
  const initializeResult = await session.nextResponse()
  assert.strictEqual(initializeResult.body.supportsSetVariable, fixture.capabilities.supportsSetVariable)
  assert.strictEqual(initializeResult.body.supportsSetExpression, fixture.capabilities.supportsSetExpression)
  assert.strictEqual(initializeResult.body.supportTerminateDebuggee, fixture.capabilities.supportTerminateDebuggee)
  assert.strictEqual(initializeResult.body.supportsLogPoints, fixture.capabilities.supportsLogPoints)

  session.handleServerEvents({
    method: 'connected',
    jsonrpc: '2.0',
    params: fixture.connectedPayload,
  })
  assert.strictEqual(session._debuggee_protocol_version, fixture.connectedPayload.protocol_version)
  assert.strictEqual(session._debuggee_module_version, fixture.connectedPayload.module_version)
  assert(
    session.outputs.some((output) => output.includes('Debugger metadata: protocol=gmod-2')),
    'Expected connected metadata output with gmod-2 protocol'
  )

  const setExpressionResponse = makeResponse('setExpression')
  session.setExpressionRequest(setExpressionResponse, {
    expression: 'foo',
    value: '1',
    frameId: 0,
  })
  const setExpressionResult = await session.nextResponse()
  assert.strictEqual(setExpressionResult.success, false)
  assert.match(setExpressionResult.message, /setExpression is not supported/)

  let debugClientEnded = false
  session._debug_client = {
    end() {
      debugClientEnded = true
    },
  }
  const disconnectResponse = makeResponse('disconnect')
  session.disconnectRequest(disconnectResponse, { terminateDebuggee: true })
  const disconnectResult = await session.nextResponse()
  assert.strictEqual(disconnectResult.success, true)
  assert.strictEqual(debugClientEnded, true)
  assert(
    session.outputs.some((output) => output.includes('terminateDebuggee is not supported')),
    'Expected explicit terminateDebuggee unsupported output'
  )

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmod-debug-parity-'))
  try {
    const sourcePath = path.join(tempDir, 'sample.lua')
    fs.writeFileSync(sourcePath, 'print("ok")\n', 'utf8')
    session.setupSourceEnv(tempDir)

    const addedBreakpoints = []
    session._debug_client = {
      clearBreakPoints() {
        return Promise.resolve()
      },
      addBreakPoint(bp) {
        addedBreakpoints.push(bp)
        return Promise.resolve()
      },
      setVar(params) {
        return Promise.resolve({ result: true, params })
      },
      end() {},
    }

    const setBreakpointsResponse = makeResponse('setBreakpoints')
    session.setBreakPointsRequest(setBreakpointsResponse, {
      source: { path: sourcePath },
      breakpoints: [{ line: 1, logMessage: 'log me' }],
    })
    const setBreakpointsResult = await session.nextResponse()
    assert.strictEqual(setBreakpointsResult.success, true)
    assert.strictEqual(setBreakpointsResult.body.breakpoints.length, 1)
    assert.strictEqual(setBreakpointsResult.body.breakpoints[0].verified, false)
    assert.match(setBreakpointsResult.body.breakpoints[0].message, /Logpoints are not supported/)
    assert.strictEqual(addedBreakpoints.length, 0)

    const setVariableResponse = makeResponse('setVariable')
    session.setVariableRequest(setVariableResponse, {
      variablesReference: 0,
      name: 'foo',
      value: '42',
    })
    const setVariableResult = await session.nextResponse()
    assert.strictEqual(setVariableResult.success, true)
    assert.strictEqual(setVariableResult.body.value, '42')

    // --- evaluation behaviour ------------------------------------------------
    // when not paused, explicit Lua eval (= prefix) should be rejected
    const evalResponse1 = makeResponse('evaluate')
    session.evaluateRequest(evalResponse1, { expression: '=1+1', context: 'repl' })
    const evalResult1 = await session.nextResponse()
    assert.strictEqual(evalResult1.success, false)
    assert.match(evalResult1.message, /paused/i)
    // no output event is emitted for this error; the text is shown via the response

    // when paused it should go through _debug_client.eval
    session._isPaused = true
    let evalCalled = false
    session._debug_client = {
      eval(params) {
        evalCalled = true
        return Promise.resolve({ result: [4], params })
      },
    }
    const evalResponse2 = makeResponse('evaluate')
    session.evaluateRequest(evalResponse2, { expression: '=2+2', context: 'repl', frameId: 0 })
    const evalResult2 = await session.nextResponse()
    assert.strictEqual(evalResult2.success, true)
    assert.strictEqual(evalResult2.body.result, '4')
    assert(evalCalled, 'Expected eval() to be invoked when paused')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  console.log('Gmod debugger parity tests passed.')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
