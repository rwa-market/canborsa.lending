/**
 * Test token faucet limits (DevNet). The faucet is a registry mint to any
 * party of the shared node, therefore: only with a protocol session, one portion per symbol per
 * party per minute, at most DAILY_PER_PARTY per day, at most DAILY_PER_IP from one IP.
 * Counters live in process memory: after a restart the day starts over; for test
 * tokens that is acceptable.
 */
export const COOLDOWN_MS = 60_000
export const DAILY_PER_PARTY = 5
export const DAILY_PER_IP = 30
const DAY_MS = 24 * 60 * 60_000

export type FaucetVerdict = { ok: true } | { ok: false; reason: string; retryAfterMs: number }

export function createFaucetLimiter(now: () => number = Date.now) {
  const last = new Map<string, number>()
  const perParty = new Map<string, number[]>()
  const perIp = new Map<string, number[]>()
  const recent = (m: Map<string, number[]>, k: string, t: number) =>
    (m.get(k) ?? []).filter((x) => t - x < DAY_MS)

  return {
    /** Check and immediately count the request. */
    take(party: string, symbol: string, ip: string): FaucetVerdict {
      const t = now()
      const key = `${party}|${symbol}`
      const prev = last.get(key)
      if (prev !== undefined && t - prev < COOLDOWN_MS)
        return {
          ok: false,
          reason: `wait a minute before asking for more ${symbol}`,
          retryAfterMs: COOLDOWN_MS - (t - prev),
        }
      const p = recent(perParty, key, t)
      if (p.length >= DAILY_PER_PARTY)
        return {
          ok: false,
          reason: `daily ${symbol} faucet limit reached for this account`,
          retryAfterMs: DAY_MS - (t - p[0]!),
        }
      const i = recent(perIp, ip, t)
      if (i.length >= DAILY_PER_IP)
        return {
          ok: false,
          reason: 'daily faucet limit reached for this network address',
          retryAfterMs: DAY_MS - (t - i[0]!),
        }
      last.set(key, t)
      perParty.set(key, [...p, t])
      perIp.set(ip, [...i, t])
      return { ok: true }
    },
  }
}
