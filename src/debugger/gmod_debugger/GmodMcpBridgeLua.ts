/**
 * Server-side Lua that the MCP tools rely on, appended to `lua/autorun/debug.lua`.
 *
 * It defines:
 * - `_GLUALS.format(value[, depth])`: a readable, size-limited rendering of any value,
 *   used by run results, frame evaluation, locals and logpoints.
 * - `_GLUALS.formatAll(...)`: renders every value of a vararg list.
 * - `_GLUALS.formatNamed(names, ...)`: renders `name = value` lines for paused-frame locals.
 * - `_GLUALS.runCaptured(code)`: runs a chunk and returns a JSON report of its return
 *   values, printed output and error.
 * - `_GLUALS.bridgeModes`: what `_GLUALS.runLua(realm, code, mode)` does for each mode.
 *   "capture" runs the chunk now. gm_rdb handles requests inside the debug hook, where
 *   LuaJIT runs no hooks, so code run now never stops at breakpoints. "defer" schedules
 *   the chunk for the next tick and returns an id, "take" returns its report once done,
 *   and "cancel" drops it if it has not started (a hibernating server runs no timers).
 *   "trace", "untrace" and "traces" start, stop and list function traces (see traceStart).
 *
 * Bump `GLUALS_MCP_BRIDGE_VERSION` when the report shape changes so the extension can
 * tell a stale bridge (server not restarted yet) from a current one.
 */
export const GLUALS_MCP_BRIDGE_VERSION = 3;

export const GLUALS_MCP_BRIDGE_LUA = String.raw`
    _GLUALS.mcpBridgeVersion = ${GLUALS_MCP_BRIDGE_VERSION}

    local FORMAT_MAX_ITEMS = 40
    local FORMAT_MAX_STRING = 400
    local FORMAT_MAX_TOTAL = 16000
    local CAPTURE_MAX_OUTPUT = 64000
    local ENTITY_TYPES = { Entity = true, Player = true, Weapon = true, NPC = true, Vehicle = true, NextBot = true, CSEnt = true }

    local function safeToString(value)
        local ok, text = pcall(tostring, value)
        if ok and type(text) == "string" then
            return text
        end
        return "<" .. type(value) .. ">"
    end

    local function quoteString(text)
        local length = #text
        local truncated = length > FORMAT_MAX_STRING
        if truncated then
            text = string.sub(text, 1, FORMAT_MAX_STRING)
        end
        local quoted = '"' .. string.gsub(text, '[%c"\\]', function(ch)
            if ch == "\n" then return "\\n" end
            if ch == "\r" then return "\\r" end
            if ch == "\t" then return "\\t" end
            if ch == '"' then return '\\"' end
            if ch == "\\" then return "\\\\" end
            return string.format("\\%03d", string.byte(ch))
        end) .. '"'
        if truncated then
            quoted = quoted .. "... (" .. length .. " bytes)"
        end
        return quoted
    end

    local function describeFunction(fn)
        local ok, info = pcall(debug.getinfo, fn, "S")
        if ok and istable(info) then
            if info.what == "C" then
                return "function: builtin"
            end
            return "function: " .. tostring(info.short_src) .. ":" .. tostring(info.linedefined)
        end
        return safeToString(fn)
    end

    local formatValue

    local function formatKey(key)
        if type(key) == "string" and string.match(key, "^[%a_][%w_]*$") then
            return key
        end
        return "[" .. formatValue(key, 0, "", {}) .. "]"
    end

    local function compareKeys(a, b)
        local ta, tb = type(a), type(b)
        if ta ~= tb then
            return ta < tb
        end
        if ta == "number" or ta == "string" then
            return a < b
        end
        return safeToString(a) < safeToString(b)
    end

    local function formatTable(value, depth, indent, seen)
        local count = 0
        for _ in pairs(value) do
            count = count + 1
        end
        local mt = getmetatable(value)
        local label = ""
        if istable(mt) and mt.__tostring ~= nil then
            label = safeToString(value) .. " "
        elseif IsColor and IsColor(value) then
            return string.format("Color(%d, %d, %d, %d)", value.r or 0, value.g or 0, value.b or 0, value.a or 255)
        end
        if count == 0 then
            return label .. "{}"
        end
        if depth <= 0 or seen[value] then
            return label .. "{...} (" .. count .. " entries" .. (seen[value] and ", cycle" or "") .. ")"
        end
        seen[value] = true

        local keys = {}
        local arrayLength = #value
        for i = 1, math.min(arrayLength, FORMAT_MAX_ITEMS) do
            keys[#keys + 1] = i
        end
        if #keys < FORMAT_MAX_ITEMS then
            local others = {}
            for key in pairs(value) do
                if not (type(key) == "number" and key >= 1 and key <= arrayLength and key % 1 == 0) then
                    others[#others + 1] = key
                end
            end
            table.sort(others, compareKeys)
            for _, key in ipairs(others) do
                if #keys >= FORMAT_MAX_ITEMS then
                    break
                end
                keys[#keys + 1] = key
            end
        end

        local childIndent = indent .. "  "
        local isSequence = arrayLength == count
        local entries = {}
        local inlineLength = 0
        local multiline = false
        for _, key in ipairs(keys) do
            local rendered = formatValue(rawget(value, key), depth - 1, childIndent, seen)
            local entry
            if isSequence then
                entry = rendered
            elseif type(key) == "number" and key <= arrayLength and key == math.floor(key) then
                entry = "[" .. key .. "] = " .. rendered
            else
                entry = formatKey(key) .. " = " .. rendered
            end
            entries[#entries + 1] = entry
            inlineLength = inlineLength + #entry + 2
            multiline = multiline or string.find(entry, "\n", 1, true) ~= nil
        end
        if count > #keys then
            entries[#entries + 1] = "... (" .. (count - #keys) .. " more)"
        end
        seen[value] = nil
        if not multiline and inlineLength <= 100 then
            return label .. "{" .. table.concat(entries, ", ") .. "}"
        end
        return label .. "{\n" .. childIndent .. table.concat(entries, ",\n" .. childIndent) .. "\n" .. indent .. "}"
    end

    formatValue = function(value, depth, indent, seen)
        local kind = type(value)
        if kind == "string" then
            return quoteString(value)
        elseif kind == "nil" or kind == "boolean" or kind == "number" then
            return tostring(value)
        elseif kind == "function" then
            return describeFunction(value)
        elseif kind == "table" then
            return formatTable(value, depth, indent, seen)
        elseif kind == "Vector" then
            return string.format("Vector(%g, %g, %g)", value.x, value.y, value.z)
        elseif kind == "Angle" then
            return string.format("Angle(%g, %g, %g)", value.p, value.y, value.r)
        elseif ENTITY_TYPES[kind] then
            return safeToString(value)
        end
        local text = safeToString(value)
        if string.find(text, kind, 1, true) == 1 then
            return text
        end
        return kind .. ": " .. text
    end

    local function clampTotal(text)
        if #text > FORMAT_MAX_TOTAL then
            return string.sub(text, 1, FORMAT_MAX_TOTAL) .. "\n... (output truncated)"
        end
        return text
    end

    function _GLUALS.format(value, depth)
        return clampTotal(formatValue(value, tonumber(depth) or 1, "", {}))
    end

    function _GLUALS.formatAll(...)
        local count = select("#", ...)
        if count == 0 then
            return "(no values)"
        end
        if count == 1 then
            return _GLUALS.format((...), 2)
        end
        local parts = {}
        for i = 1, count do
            parts[i] = i .. ": " .. formatValue((select(i, ...)), 2, "", {})
        end
        return clampTotal(table.concat(parts, "\n"))
    end

    function _GLUALS.formatNamed(names, ...)
        local parts = {}
        for i = 1, #names do
            parts[i] = names[i] .. " = " .. formatValue((select(i, ...)), 1, "", {})
        end
        return clampTotal(table.concat(parts, "\n"))
    end

    local function pack(...)
        return { n = select("#", ...), ... }
    end

    -- Hit counts for logpoints with a hit condition (see logpoint.ts).
    local logpointCounts = {}
    function _GLUALS.countLogpoint(key)
        local count = (logpointCounts[key] or 0) + 1
        logpointCounts[key] = count
        return count
    end

    local function joinArgs(separator, ...)
        local parts = {}
        for i = 1, select("#", ...) do
            local value = select(i, ...)
            if not (IsColor and IsColor(value)) then
                parts[#parts + 1] = safeToString(value)
            end
        end
        return table.concat(parts, separator)
    end

    local function cutTraceback(traceback)
        local lines = {}
        for line in string.gmatch(traceback or "", "[^\n]+") do
            if string.find(line, "in function 'xpcall'", 1, true) then
                break
            end
            if not string.find(line, "^stack traceback:") then
                lines[#lines + 1] = string.gsub(line, "^%s+", "")
            end
        end
        return lines
    end

    function _GLUALS.runCaptured(code, chunkName)
        local output = {}
        local outputSize = 0
        local function capture(text)
            if outputSize < CAPTURE_MAX_OUTPUT then
                output[#output + 1] = text
                outputSize = outputSize + #text
            end
        end

        local originals = { print = print, Msg = Msg, MsgN = MsgN, MsgC = MsgC }
        local wrappers = {
            print = function(...) capture(joinArgs("\t", ...) .. "\n") return originals.print(...) end,
            Msg = function(...) capture(joinArgs("", ...)) return originals.Msg(...) end,
            MsgN = function(...) capture(joinArgs("", ...) .. "\n") return originals.MsgN(...) end,
            MsgC = function(...) capture(joinArgs("", ...)) return originals.MsgC(...) end,
        }
        for name, wrapper in pairs(wrappers) do
            if originals[name] then
                _G[name] = wrapper
            end
        end

        local started = SysTime()
        local report = {}
        local ranOk, ranErr = pcall(function()
            -- With handleError false, CompileString returns the error message instead of a function.
            local fn = CompileString(code, chunkName or "gluals_mcp", false)
            if not isfunction(fn) then
                report.ok = false
                report.phase = "compile"
                report.error = tostring(fn)
                return
            end
            local results = pack(xpcall(fn, function(err)
                return { message = safeToString(err), traceback = debug.traceback("", 2) }
            end))
            if results[1] then
                report.ok = true
                local returns = {}
                for i = 2, results.n do
                    returns[#returns + 1] = clampTotal(formatValue(results[i], 2, "", {}))
                end
                report.returns = returns
                report.returnCount = results.n - 1
            else
                local failure = results[2]
                report.ok = false
                report.phase = "runtime"
                if istable(failure) then
                    report.error = failure.message
                    report.traceback = cutTraceback(failure.traceback)
                else
                    report.error = safeToString(failure)
                end
            end
        end)

        for name, wrapper in pairs(wrappers) do
            if _G[name] == wrapper then
                _G[name] = originals[name]
            end
        end

        if not ranOk then
            report.ok = false
            report.phase = "bridge"
            report.error = safeToString(ranErr)
        end
        report.output = table.concat(output)
        report.durationMs = math.floor((SysTime() - started) * 100000 + 0.5) / 100
        report.bridgeVersion = _GLUALS.mcpBridgeVersion
        return util.TableToJSON(report)
    end

    local deferredRuns = {}
    local nextDeferredId = 0
    local DEFERRED_KEEP_SECONDS = 600
    -- A hibernating server (no players, sv_hibernate_think 0) runs no Think and no timers.
    -- Replies say how long ago Think last ran so the extension can tell.
    local lastThink = SysTime()
    hook.Add("Think", "GLuaLS.MCP.Tick", function()
        lastThink = SysTime()
    end)
    local function deferredStatus(state, id)
        return util.TableToJSON({ id = id, state = state, sinceThink = SysTime() - lastThink })
    end

    -- Function tracing: a traced function is swapped for a wrapper that prints its
    -- arguments and return values, until max_calls or max_seconds is reached.
    local activeTraces = {}
    local nextTraceId = 0
    local TRACE_MAX_LINE = 600

    local function clampLine(text)
        if #text > TRACE_MAX_LINE then
            return string.sub(text, 1, TRACE_MAX_LINE) .. "..."
        end
        return text
    end

    -- "MyAddon.Config.Get", "MyAddon:Method" or "Player:Nick" (a metatable from FindMetaTable).
    local function resolveFunction(path)
        local segments = {}
        for segment in string.gmatch(path, "[^%.:]+") do
            segments[#segments + 1] = segment
        end
        if #segments == 0 then
            return nil, "no function name given"
        end
        local container = _G
        -- "Player:Nick": a global named Player exists but is a function, so use the class.
        if #segments > 1 and not istable(_G[segments[1]]) then
            local meta = FindMetaTable and FindMetaTable(segments[1])
            if not istable(meta) then
                return nil, "there is no global table or class named " .. segments[1]
            end
            container = meta
            table.remove(segments, 1)
        end
        for i = 1, #segments - 1 do
            local value = container[segments[i]]
            if not istable(value) then
                return nil, table.concat(segments, ".", 1, i) .. " is not a table"
            end
            container = value
        end
        local key = segments[#segments]
        local fn = container[key]
        if not isfunction(fn) then
            return nil, path .. " is not a function (it is " .. type(fn) .. ")"
        end
        return container, key, fn
    end

    local function parameterNames(fn)
        local names = {}
        for i = 1, 60 do
            local ok, name = pcall(debug.getlocal, fn, i)
            if not ok or not name then
                break
            end
            names[i] = name
        end
        return names
    end

    -- A call that raised an error never reaches its "returned" line. Calling the function
    -- through pcall would change the error's stack, so say so on the next call instead.
    local function countOnStack(fn)
        local count = 0
        for level = 2, 250 do
            local info = debug.getinfo(level, "f")
            if not info then
                break
            end
            if info.func == fn then
                count = count + 1
            end
        end
        return count
    end

    -- "running" is how many of the wrapper's frames belong to the caller (1 inside the wrapper).
    local function reportUnreturned(trace, running)
        if trace.pending and countOnStack(trace.wrapper) <= running then
            print(string.format("[trace %s] #%d did not return: it raised an error (server_errors has it with the stack, unless the caller caught it with pcall)", trace.path, trace.pending))
            trace.pending = nil
        end
    end

    local function stopTrace(trace, reason)
        if activeTraces[trace.id] ~= trace then
            return
        end
        reportUnreturned(trace, 0)
        activeTraces[trace.id] = nil
        timer.Remove("GLuaLS.MCP.Trace" .. trace.id)
        if trace.container[trace.key] == trace.wrapper then
            if trace.own then
                trace.container[trace.key] = trace.original
            else
                rawset(trace.container, trace.key, nil)
            end
        end
        local hooks = hook.GetTable()
        for _, entry in ipairs(trace.hooks) do
            if hooks[entry.event] and hooks[entry.event][entry.name] == trace.wrapper then
                hook.Add(entry.event, entry.name, trace.original)
            end
        end
        print(string.format("[trace %s] stopped after %d call(s): %s", trace.path, trace.calls, reason))
    end

    local function traceStart(path, maxCalls, maxSeconds)
        -- Named so a paused stack reads "in tracedFunction" for the traced function's frame.
        local container, key, tracedFunction = resolveFunction(path)
        if not container then
            return { ok = false, error = key }
        end
        local original = tracedFunction
        for _, existing in pairs(activeTraces) do
            if existing.path == path then
                stopTrace(existing, "replaced by a new trace")
            end
        end
        nextTraceId = nextTraceId + 1
        local trace = {
            id = nextTraceId, path = path, container = container, key = key, original = original,
            own = rawget(container, key) == original, calls = 0, maxCalls = maxCalls, hooks = {},
            expires = SysTime() + maxSeconds,
        }
        local names = parameterNames(original)
        local label = "[trace " .. path .. "]"
        trace.wrapper = function(...)
            if activeTraces[trace.id] ~= trace then
                return original(...)
            end
            reportUnreturned(trace, 1)
            -- Calls that raised an error never reached the max_calls check after returning.
            if trace.calls >= trace.maxCalls then
                stopTrace(trace, "reached max_calls")
                return tracedFunction(...)
            end
            trace.calls = trace.calls + 1
            local n = trace.calls
            local count = select("#", ...)
            local parts = {}
            for i = 1, count do
                parts[#parts + 1] = (names[i] or ("arg" .. i)) .. " = " .. formatValue((select(i, ...)), 1, "", {})
            end
            print(clampLine(string.format("%s #%d called (%s)", label, n, table.concat(parts, ", "))))
            local started = SysTime()
            local outermost = trace.pending == nil
            if outermost then
                trace.pending = n
            end
            local results = pack(tracedFunction(...))
            if outermost then
                trace.pending = nil
            end
            local rendered = {}
            for i = 1, results.n do
                rendered[i] = formatValue(results[i], 1, "", {})
            end
            print(clampLine(string.format("%s #%d returned %s (%.3f ms)", label, n,
                results.n == 0 and "nothing" or table.concat(rendered, ", "), (SysTime() - started) * 1000)))
            if n >= trace.maxCalls then
                stopTrace(trace, "reached max_calls")
            end
            return unpack(results, 1, results.n)
        end
        container[key] = trace.wrapper
        -- hook.Add stores its own reference, so point hooks running this function at the wrapper too.
        for event, hooks in pairs(hook.GetTable()) do
            for name, fn in pairs(hooks) do
                if fn == original then
                    trace.hooks[#trace.hooks + 1] = { event = event, name = name }
                end
            end
        end
        for _, entry in ipairs(trace.hooks) do
            hook.Add(entry.event, entry.name, trace.wrapper)
        end
        activeTraces[trace.id] = trace
        timer.Create("GLuaLS.MCP.Trace" .. trace.id, maxSeconds, 1, function()
            stopTrace(trace, "reached max_seconds")
        end)
        local hookNames = {}
        for _, entry in ipairs(trace.hooks) do
            hookNames[#hookNames + 1] = tostring(entry.event) .. "/" .. tostring(entry.name)
        end
        return { ok = true, path = path, params = names, hooks = hookNames, maxCalls = maxCalls, maxSeconds = maxSeconds }
    end

    -- A call that raised an error never returns to the wrapper. Report it on the next tick,
    -- when no traced call can still be running, and stop a trace whose last call that was.
    hook.Add("Think", "GLuaLS.MCP.Traces", function()
        if next(activeTraces) == nil then
            return
        end
        for _, trace in pairs(activeTraces) do
            if trace.pending then
                reportUnreturned(trace, 0)
            end
            if not trace.pending and trace.calls >= trace.maxCalls then
                stopTrace(trace, "reached max_calls")
            end
        end
    end)

    local function decodeArgs(code)
        local ok, args = pcall(util.JSONToTable, code)
        return ok and istable(args) and args or {}
    end

    _GLUALS.bridgeModes = {
        trace = function(code)
            local args = decodeArgs(code)
            local maxCalls = math.max(1, math.floor(tonumber(args.maxCalls) or 20))
            local maxSeconds = math.max(1, tonumber(args.maxSeconds) or 120)
            return util.TableToJSON(traceStart(tostring(args.path or ""), maxCalls, maxSeconds))
        end,
        untrace = function(code)
            local args = decodeArgs(code)
            local stopped = {}
            for _, trace in pairs(activeTraces) do
                if args.path == nil or trace.path == args.path then
                    stopped[#stopped + 1] = { path = trace.path, calls = trace.calls }
                    stopTrace(trace, "stopped by the agent")
                end
            end
            return util.TableToJSON({ stopped = stopped })
        end,
        traces = function()
            local list = {}
            for _, trace in pairs(activeTraces) do
                list[#list + 1] = {
                    path = trace.path, calls = trace.calls, maxCalls = trace.maxCalls,
                    secondsLeft = math.max(0, math.floor(trace.expires - SysTime())), hooks = #trace.hooks,
                }
            end
            return util.TableToJSON({ traces = list })
        end,
        capture = function(code)
            return _GLUALS.runCaptured(code)
        end,
        defer = function(code)
            local now = SysTime()
            for id, entry in pairs(deferredRuns) do
                if now - entry.created > DEFERRED_KEEP_SECONDS then
                    deferredRuns[id] = nil
                end
            end
            nextDeferredId = nextDeferredId + 1
            local id = tostring(nextDeferredId)
            local entry = { state = "scheduled", created = now }
            deferredRuns[id] = entry
            timer.Simple(0, function()
                if entry.state ~= "scheduled" then
                    return
                end
                entry.state = "running"
                entry.report = _GLUALS.runCaptured(code)
                entry.state = "done"
            end)
            return deferredStatus("scheduled", id)
        end,
        take = function(id)
            local entry = deferredRuns[id]
            if not entry then
                return deferredStatus("unknown", id)
            end
            if entry.state == "done" then
                deferredRuns[id] = nil
                return entry.report
            end
            return deferredStatus(entry.state, id)
        end,
        cancel = function(id)
            local entry = deferredRuns[id]
            if entry and entry.state == "scheduled" then
                entry.state = "cancelled"
                deferredRuns[id] = nil
                return deferredStatus("cancelled", id)
            end
            return deferredStatus(entry and entry.state or "unknown", id)
        end,
    }
`;
