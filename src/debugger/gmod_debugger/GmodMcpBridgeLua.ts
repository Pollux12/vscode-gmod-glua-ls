/**
 * Server-side Lua that the MCP tools rely on, appended to `lua/autorun/debug.lua`.
 *
 * It defines:
 * - `_GLUALS.format(value[, depth])`: a readable, size-limited rendering of any value,
 *   used by run results, frame evaluation, locals and logpoints.
 * - `_GLUALS.formatAll(...)`: renders every value of a vararg list.
 * - `_GLUALS.formatNamed(names, ...)`: renders `name = value` lines for paused-frame locals.
 * - `_GLUALS.runCaptured(code)`: runs a chunk and returns a JSON report of its return
 *   values, printed output and error. `_GLUALS.runLua(realm, code, "capture")` calls it.
 *
 * Bump `GLUALS_MCP_BRIDGE_VERSION` when the report shape changes so the extension can
 * tell a stale bridge (server not restarted yet) from a current one.
 */
export const GLUALS_MCP_BRIDGE_VERSION = 1;

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
`;
