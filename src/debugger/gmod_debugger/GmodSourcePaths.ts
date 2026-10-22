import * as path from 'path'

export type PathApi = Pick<typeof path, 'relative' | 'resolve' | 'isAbsolute' | 'sep'>

/** Returns `target` relative to `root`, or undefined when `target` is outside `root` (case-insensitive on Windows). */
export function relativeWithin(root: string, target: string, pathApi: PathApi = path): string | undefined {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target))
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return undefined
  }
  return relative
}
