/**
 * Leadership lease for bots during a blue/green deploy: two backend processes run side by side
 * while nginx switches traffic, and the bots must run in one of them (otherwise duplicate
 * liquidator requests and duplicate prices). The lease is a file {pid, at}: the owner refreshes it
 * every ttl/3; a new process takes the lease when the owner released it, died or has not refreshed
 * it for longer than ttl.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

interface Lease {
  pid: number
  at: number
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function createLeaderLease(opts: {
  file: string
  ttlMs?: number
  pid?: number
  now?: () => number
  isAlive?: (pid: number) => boolean
}) {
  const ttl = opts.ttlMs ?? 15_000
  const pid = opts.pid ?? process.pid
  const now = opts.now ?? Date.now
  const isAlive = opts.isAlive ?? alive
  let timer: NodeJS.Timeout | null = null

  const read = (): Lease | null => {
    try {
      return JSON.parse(readFileSync(opts.file, 'utf8')) as Lease
    } catch {
      return null
    }
  }
  const write = () => {
    const tmp = `${opts.file}.${pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pid, at: now() } satisfies Lease))
    renameSync(tmp, opts.file)
  }

  /** Try to take the lease; true means we are the leader. */
  function tryAcquire(): boolean {
    const cur = read()
    const free = !cur || cur.pid === pid || !isAlive(cur.pid) || now() - cur.at > ttl
    if (!free) return false
    write()
    // race of two processes: the last rename wins, check whose file remained
    return read()?.pid === pid
  }

  /** Wait for the lease, then hold it; onLost fires if the lease was taken over. */
  async function acquire(signal?: AbortSignal, onLost?: () => void): Promise<boolean> {
    while (!signal?.aborted) {
      if (tryAcquire()) {
        timer = setInterval(() => {
          if (read()?.pid !== pid) {
            release()
            onLost?.()
            return
          }
          write()
        }, ttl / 3)
        timer.unref()
        return true
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
    return false
  }

  function release() {
    if (timer) clearInterval(timer)
    timer = null
    if (read()?.pid === pid) rmSync(opts.file, { force: true })
  }

  return { tryAcquire, acquire, release }
}
