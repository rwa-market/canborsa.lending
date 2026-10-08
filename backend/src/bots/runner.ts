import type { BotStatus } from '@lending/shared'
import type { FastifyBaseLogger } from 'fastify'
import { classifyLedgerError } from '../ledger/client.ts'

/**
 * Bots share a lock: steps with a shared lock run in turn. Parallel operator and oracle
 * transactions consume the same contracts (Pool, PriceFeed) and Canton rejects them
 * as "referring to locked contracts".
 *
 * Bots that do not touch Pool and PriceFeed take their own lock (audit H4): an AccountRequest
 * flood holds only the `accounts` lock, and price publishing does not wait for it.
 */
const queues = new Map<string, Promise<unknown>>()

export const PROTOCOL_LOCK = 'protocol'

export function exclusive<T>(fn: () => Promise<T>, lock = PROTOCOL_LOCK): Promise<T> {
  const queue = queues.get(lock) ?? Promise.resolve()
  const run = queue.then(fn, fn)
  queues.set(
    lock,
    run.catch(() => undefined),
  )
  return run
}

/**
 * Process bot state for /health/ready and /metrics (B-10): time of the last run
 * and success, consecutive errors. After `threshold` consecutive errors the bot is in error state.
 */
export function createBotRegistry(threshold = 3, now: () => number = Date.now) {
  const bots = new Map<
    string,
    {
      lastRunAt: number | null
      lastSuccessAt: number | null
      failures: number
      totalFailures: number
      lastError: string | null
      stopped: boolean
    }
  >()
  const get = (name: string) => {
    let b = bots.get(name)
    if (!b) {
      b = {
        lastRunAt: null,
        lastSuccessAt: null,
        failures: 0,
        totalFailures: 0,
        lastError: null,
        stopped: false,
      }
      bots.set(name, b)
    }
    return b
  }
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
  return {
    register: (name: string) => void get(name),
    started(name: string) {
      const b = get(name)
      b.lastRunAt = now()
      b.stopped = false
    },
    succeeded(name: string) {
      const b = get(name)
      b.lastSuccessAt = now()
      b.failures = 0
    },
    failed(name: string, err: unknown) {
      const b = get(name)
      b.failures++
      b.totalFailures++
      // into the status: the error class and the start of the text, no response bodies
      b.lastError = String(err instanceof Error ? err.message : err).slice(0, 200)
    },
    stopped(name: string) {
      get(name).stopped = true
    },
    list(): BotStatus[] {
      return [...bots.entries()].map(([name, b]) => ({
        name,
        state: b.stopped
          ? 'stopped'
          : b.failures >= threshold
            ? 'error'
            : b.lastSuccessAt === null
              ? 'starting'
              : 'ok',
        lastRunAt: iso(b.lastRunAt),
        lastSuccessAt: iso(b.lastSuccessAt),
        consecutiveFailures: b.failures,
        lastError: b.lastError,
      }))
    },
    totalFailures: (name: string) => get(name).totalFailures,
  }
}

export type BotRegistry = ReturnType<typeof createBotRegistry>

export interface BotHandle {
  /** Clear the timer and wait for the current step (B-14). */
  stop(): Promise<void>
}

/** Runs a step every `ms`, never overlapping itself or bots with the same lock. */
export function every(
  name: string,
  ms: number,
  step: () => Promise<unknown>,
  log: FastifyBaseLogger,
  lock = PROTOCOL_LOCK,
  registry?: BotRegistry,
): BotHandle {
  let current: Promise<void> | null = null
  let stopped = false
  registry?.register(name)
  const tick = () => {
    if (current || stopped) return
    current = exclusive(async () => {
      // shutdown arrived while the step was waiting for the lock: do not start
      if (stopped) return
      registry?.started(name)
      await step()
      registry?.succeeded(name)
    }, lock)
      .catch((err: unknown) => {
        registry?.failed(name, err)
        const kind = classifyLedgerError(err)
        log.warn({ bot: name, kind, err: String(err) }, 'bot step failed')
      })
      .finally(() => {
        current = null
      })
  }
  tick()
  const timer = setInterval(tick, ms)
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      registry?.stopped(name)
      await current
    },
  }
}

/** Wait for the bots to stop, but no longer than `timeoutMs`: false if they did not stop. */
export async function stopAllBots(handles: BotHandle[], timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const done = Promise.all(handles.map((h) => h.stop())).then(() => true)
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), timeoutMs)
    timer.unref()
  })
  const ok = await Promise.race([done, timeout])
  clearTimeout(timer)
  return ok
}

/**
 * Transient error: retry in the next cycle rather than cancel the operation (A-8).
 * This covers timeout, network, 503 and a duplicate command: the outcome is unknown or already
 * accepted. CONTRACT_NOT_FOUND too: Pool and PriceFeed are recreated all the time; archived bid
 * inputs are caught by `mentionsAny` before this check (audit H3).
 */
export const isContention = (err: unknown) =>
  classifyLedgerError(err) !== 'rejected' ||
  /CONTRACT_NOT_FOUND|LOCAL_VERDICT_INACTIVE|INCONSISTENT/i.test(String(err))

/** The error names one of these contracts, e.g. an archived bid holding. */
export const mentionsAny = (err: unknown, contractIds: Iterable<string>) => {
  const text = String(err)
  for (const cid of contractIds) if (cid && text.includes(cid)) return true
  return false
}
