/**
 * Opening accounts from requests (audit V1): one account per user, only the operator sees the
 * registry.
 *
 * AccountRequest flood protection (follow-up audit H4): a request is free for any party.
 * - per step we open at most MAX_OPENS_PER_STEP accounts, one request per party;
 * - repeat requests from a party with an account are rejected in bulk: Directory_Reject does not
 *   consume the registry, so many rejections go in one transaction, and they are also capped by the
 *   limit;
 * - duplicates from a party without an account wait until the first request is opened, then get
 *   rejected;
 * - the bot runs under its own lock (runner.ts), price publishing does not wait for it;
 * - B-16: at most opensPerDay opens per rolling 24 h; when hit, error in the log
 *   (a burst of Sybil requests), requests wait for the next window.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Deployment } from '../deployment.ts'
import type { ActiveContract, LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import type { Reader } from '../protocol/reader.ts'
import type { AccountRequestPayload } from '../protocol/types.ts'

export const MAX_OPENS_PER_STEP = 10
export const MAX_REJECTS_PER_STEP = 100
export const REJECTS_PER_TX = 25

/** What to do with the requests in a step: a pure function, covered by a unit test. */
export function planAccountRequests<
  R extends Pick<ActiveContract<AccountRequestPayload>, 'payload'>,
>(
  requests: R[],
  operator: string,
  holders: Set<string>,
  limits = { opens: MAX_OPENS_PER_STEP, rejects: MAX_REJECTS_PER_STEP },
) {
  const open: R[] = []
  const reject: R[] = []
  const seen = new Set<string>()
  for (const r of requests) {
    if (r.payload.operator !== operator) continue
    const user = r.payload.user
    if (holders.has(user)) {
      if (reject.length < limits.rejects) reject.push(r)
    } else if (!seen.has(user) && open.length < limits.opens) {
      open.push(r)
    }
    seen.add(user)
  }
  return { open, reject }
}

export const DAY_MS = 86_400_000

export function createAccountBot(
  ledger: LedgerClient,
  reader: Reader,
  d: Deployment,
  log: FastifyBaseLogger,
  opts: { opensPerDay?: number; now?: () => number } = {},
) {
  const perDay = opts.opensPerDay ?? 500
  const now = opts.now ?? Date.now
  /** Open times over the last 24 h (in memory: after a restart the window starts over) */
  const opened: number[] = []
  let alerted = false
  const directoryCmd = (directoryCid: string, choice: string, requestCid: string) => ({
    ExerciseCommand: {
      templateId: TEMPLATES.accountDirectory,
      contractId: directoryCid,
      choice,
      choiceArgument: { requestCid },
    },
  })

  return async function openAccounts(): Promise<number> {
    const requests = await reader.accountRequests()
    if (requests.length === 0) return 0
    const holders = new Set((await reader.accounts()).map((a) => a.payload.owner))
    const t = now()
    while (opened.length && t - opened[0]! > DAY_MS) opened.shift()
    const budget = Math.max(0, perDay - opened.length)
    const plan = planAccountRequests(requests, d.operator, holders, {
      opens: Math.min(MAX_OPENS_PER_STEP, budget),
      rejects: MAX_REJECTS_PER_STEP,
    })
    if (budget === 0 && requests.some((r) => !holders.has(r.payload.user))) {
      if (!alerted)
        log.error({ perDay }, 'daily account opening limit reached: possible Sybil flood')
      alerted = true
    } else if (budget > 0) alerted = false
    let n = 0
    for (let i = 0; i < plan.reject.length; i += REJECTS_PER_TX) {
      const chunk = plan.reject.slice(i, i + REJECTS_PER_TX)
      try {
        const directory = await reader.directory()
        await ledger.submit(
          [d.operator],
          chunk.map((r) => directoryCmd(directory.contractId, 'Directory_Reject', r.contractId)),
        )
        n += chunk.length
      } catch (err) {
        log.warn({ err: String(err), count: chunk.length }, 'account request rejection failed')
      }
    }
    for (const r of plan.open) {
      try {
        // Directory_Open consumes the registry: a fresh id every time
        const directory = await reader.directory()
        await ledger.submit(
          [d.operator],
          [directoryCmd(directory.contractId, 'Directory_Open', r.contractId)],
        )
        opened.push(now())
        n++
      } catch (err) {
        log.warn({ err: String(err) }, 'account request failed')
      }
    }
    if (n)
      log.info(
        { opened: plan.open.length, rejected: plan.reject.length },
        'account requests processed',
      )
    return n
  }
}
