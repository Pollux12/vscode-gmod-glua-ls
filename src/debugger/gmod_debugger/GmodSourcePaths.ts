import * as fs from 'fs'
import * as path from 'path'

export type PathApi = Pick<typeof path, 'relative' | 'resolve' | 'isAbsolute' | 'join' | 'sep'>

export interface GmodSourceMapping {
  sourceRoot?: string
  sourceFileMap?: Record<string, string>
}

/** Returns `target` relative to `root`, or undefined when `target` is outside `root` (case-insensitive on Windows). */
export function relativeWithin(root: string, target: string, pathApi: PathApi = path): string | undefined {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target))
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return undefined
  }
  return relative
}

/** Maps a local file to its garrysmod-relative path through the most specific `sourceFileMap` folder, then `sourceRoot`. */
export function clientPathToGamePath(
  clientPath: string,
  mapping: GmodSourceMapping,
  pathApi: PathApi = path
): string | undefined {
  let best: { rootLength: number; gamePath: string } | undefined
  for (const [source, target] of Object.entries(mapping.sourceFileMap ?? {})) {
    const relative = relativeWithin(source, clientPath, pathApi)
    const rootLength = pathApi.resolve(source).length
    if (relative !== undefined && (!best || rootLength > best.rootLength)) {
      best = { rootLength, gamePath: pathApi.join(target, relative) }
    }
  }
  if (best) {
    return best.gamePath
  }
  return mapping.sourceRoot === undefined ? undefined : relativeWithin(mapping.sourceRoot, clientPath, pathApi)
}

/**
 * Maps a garrysmod-relative path to a local file through the most specific `sourceFileMap` folder, then `sourceRoot`.
 * A mapped folder outside `sourceRoot` that holds the file wins, as it is the checkout the server's copy came from.
 */
export function gamePathToClientPath(
  gamePath: string,
  mapping: GmodSourceMapping,
  pathApi: PathApi = path,
  exists: (file: string) => boolean = fs.existsSync
): string | undefined {
  const anchored = (gameRelative: string) => pathApi.resolve(pathApi.sep, gameRelative)
  const candidates: Array<{ rootLength: number; clientPath: string }> = []
  for (const [source, target] of Object.entries(mapping.sourceFileMap ?? {})) {
    const relative = relativeWithin(anchored(target), anchored(gamePath), pathApi)
    if (relative !== undefined) {
      candidates.push({ rootLength: anchored(target).length, clientPath: pathApi.join(source, relative) })
    }
  }
  candidates.sort((a, b) => b.rootLength - a.rootLength)
  const { sourceRoot } = mapping
  const inCheckout = (clientPath: string) =>
    sourceRoot !== undefined && relativeWithin(sourceRoot, clientPath, pathApi) === undefined && exists(clientPath)
  const chosen = candidates.find((candidate) => inCheckout(candidate.clientPath)) ?? candidates[0]
  if (chosen) {
    return chosen.clientPath
  }
  return sourceRoot === undefined ? undefined : pathApi.join(sourceRoot, gamePath)
}

/** The debug adapter's conversions between local files and the paths gm_rdb uses, where a chunk name starts with `@`. */
export function debuggerPathConverters(sourceRoot: string, sourceFileMap?: Record<string, string>, pathApi: PathApi = path) {
  const mapping = { sourceRoot, sourceFileMap }
  return {
    toDebugger: (clientPath: string): string =>
      clientPathToGamePath(clientPath, mapping, pathApi) ?? pathApi.relative(sourceRoot, clientPath),
    toClient: (chunkName: string): string => {
      if (!chunkName.startsWith('@')) {
        return ''
      }
      const file = chunkName.slice(1)
      return pathApi.isAbsolute(file) ? file : gamePathToClientPath(file, mapping, pathApi) ?? file
    },
  }
}

/** Returns the Lua search path `include` takes for a garrysmod-relative file, or undefined when the file is not on it. */
export function gamePathToLuaPath(gamePath: string): string | undefined {
  const segments = gamePath.split(/[\\/]+/).filter((segment) => segment.length > 0)
  const lowered = segments.map((segment) => segment.toLowerCase())
  const isLuaRoot = (segment?: string) => segment === 'lua' || segment === 'gamemodes'
  const rootLength = isLuaRoot(lowered[0]) ? 1 : lowered[0] === 'addons' && isLuaRoot(lowered[2]) ? 3 : 0
  if (rootLength === 0 || segments.length <= rootLength) {
    return undefined
  }
  return segments.slice(rootLength).join('/')
}
