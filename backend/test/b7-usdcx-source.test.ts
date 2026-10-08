/**
 * B-7: the USDCx price source is configured separately from USDC (ORACLE_SOURCES by the
 * InstrumentId slot from deployment.json), depeg bound ORACLE_USDCX_DEPEG_BOUND.
 * There is no public USDCx feed: by default USDCx is quoted as USDC, visible in the metric.
 */
import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createOracle } from '../src/bots/oracle.ts'
import {
  buildPriceSources,
  binance,
  bybit,
  coinpaprika,
  kucoin,
  type PriceSource,
  usdcxQuotedAsUsdc,
} from '../src/bots/prices.ts'
import { loadConfig } from '../src/config.ts'
import type { Deployment } from '../src/deployment.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createMetrics } from '../src/metrics.ts'

const d = {
  oracle: 'oracle::1',
  operator: 'op::1',
  usdcx: { admin: 'circle::1', id: 'USDCx' },
  cc: { admin: 'DSO::1', id: 'Amulet' },
  cbtc: { admin: 'bitsafe::1', id: 'CBTC' },
} as Deployment

const logs: { level: string; msg: string }[] = []
const log = {
  info: () => {},
  warn: (_o: unknown, msg?: string) => logs.push({ level: 'warn', msg: msg ?? '' }),
  error: (_o: unknown, msg?: string) => logs.push({ level: 'error', msg: msg ?? '' }),
} as unknown as FastifyBaseLogger

function ledger() {
  const submitted: { cid: string; quotes: { source: string; price: string }[] }[] = []
  const feeds = (['usdcx', 'cc', 'cbtc'] as const).map((slot) => ({
    contractId: `feed-${slot}`,
    payload: { oracle: d.oracle, instrumentId: d[slot], observers: [], quotes: [] },
  }))
  return {
    submitted,
    ledger: {
      query: async () => feeds,
      submit: async (
        _a: string[],
        cmds: { ExerciseCommand: { contractId: string; choiceArgument: { newQuotes: never } } }[],
      ) => {
        for (const c of cmds)
          submitted.push({
            cid: c.ExerciseCommand.contractId,
            quotes: c.ExerciseCommand.choiceArgument.newQuotes,
          })
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient,
  }
}

const quote = (price: string) => ({ price, observedAt: new Date().toISOString() })

describe('B-7: ORACLE_SOURCES per instrument', () => {
  it('the list form applies to every instrument (as before)', () => {
    const c = loadConfig({ ORACLE_SOURCES: 'coingecko,coinpaprika' })
    expect(c.ORACLE_SOURCES).toEqual({
      usdcx: ['coingecko', 'coinpaprika'],
      cc: ['coingecko', 'coinpaprika'],
      cbtc: ['coingecko', 'coinpaprika'],
    })
  })

  it('the JSON form sets USDCx sources apart from USDC; old symbol keys are accepted', () => {
    const c = loadConfig({
      ORACLE_SOURCES:
        '{"USDCx":["xreserve","circle"],"cc":["coingecko","coinpaprika"],"cbtc":["coingecko","coinpaprika"]}',
    })
    expect(c.ORACLE_SOURCES.usdcx).toEqual(['xreserve', 'circle'])
  })

  it('the JSON form must name all three instruments', () => {
    expect(() => loadConfig({ ORACLE_SOURCES: '{"cc":["coingecko","coinpaprika"]}' })).toThrow(
      /usdcx/,
    )
  })

  it('each source quotes only the instruments it is configured for', () => {
    const c = loadConfig({
      ORACLE_SOURCES:
        '{"usdcx":["xreserve","coingecko"],"cc":["coingecko","coinpaprika"],"cbtc":["coingecko","coinpaprika"]}',
      ORACLE_HTTP_SOURCES:
        '[{"name":"xreserve","url":"https://x.example/{id}","ids":{"usdcx":"usdcx"},"pricePath":"p","timePath":"t"}]',
    })
    const byName = Object.fromEntries(buildPriceSources(c).map((s) => [s.name, s.slots]))
    expect(byName).toEqual({
      coingecko: ['usdcx', 'cc', 'cbtc'],
      coinpaprika: ['cc', 'cbtc'],
      xreserve: ['usdcx'],
    })
  })

  it('an unknown source name fails at start', () => {
    const c = loadConfig({
      ORACLE_SOURCES: '{"usdcx":["nope"],"cc":["coingecko"],"cbtc":["coingecko"]}',
    })
    expect(() => buildPriceSources(c)).toThrow(/nope/)
  })

  it('the oracle asks a source only for its instruments and ignores the rest', async () => {
    const asked: string[][] = []
    const src = (name: string, slots: PriceSource['slots']): PriceSource => ({
      name,
      ...(slots ? { slots } : {}),
      fetch: async (s) => {
        asked.push(s)
        // the source returns more than it was asked for
        return { usdcx: quote('1'), cc: quote('0.2'), cbtc: quote('100000') }
      },
    })
    const l = ledger()
    const publish = createOracle(
      l.ledger,
      d,
      [src('usdc-a', ['cc', 'cbtc']), src('usdc-b', ['cc', 'cbtc']), src('only-usdcx', ['usdcx'])],
      log,
      { minSources: 2 },
    )
    const out = await publish()
    expect(asked).toEqual([['cc', 'cbtc'], ['cc', 'cbtc'], ['usdcx']])
    // USDCx has one source of the two required: the feed is not published
    expect(out).toEqual(['cc', 'cbtc'])
  })
})

describe('B-7: USDCx depeg bound', () => {
  const run = async (price: string, bound = '0.02') => {
    const metrics = createMetrics()
    const l = ledger()
    logs.length = 0
    const s = (name: string): PriceSource => ({
      name,
      fetch: async () => ({ usdcx: quote(price), cc: quote('0.2'), cbtc: quote('100000') }),
    })
    const publish = createOracle(
      l.ledger,
      d,
      [s('a'), s('b')],
      log,
      { usdcxDepegBound: bound },
      metrics,
    )
    const out = await publish()
    return { out, metrics }
  }

  it('beyond the bound: still published (the contract pauses borrowing), alert and metric', async () => {
    const { out, metrics } = await run('0.97')
    expect(out).toContain('usdcx')
    expect(metrics.get('oracle_usdcx_depeg')).toBe(1)
    expect(logs.some((l) => l.level === 'error' && /depeg/i.test(l.msg))).toBe(true)
  })

  it('exactly at the bound is no depeg', async () => {
    expect((await run('0.98')).metrics.get('oracle_usdcx_depeg')).toBe(0)
    expect((await run('1.02')).metrics.get('oracle_usdcx_depeg')).toBe(0)
    expect((await run('1.0200000001')).metrics.get('oracle_usdcx_depeg')).toBe(1)
  })

  it('ORACLE_USDCX_DEPEG_BOUND defaults to 0.02', () => {
    expect(loadConfig({}).ORACLE_USDCX_DEPEG_BOUND).toBe('0.02')
    expect(() => loadConfig({ ORACLE_USDCX_DEPEG_BOUND: '1.5' })).toThrow()
  })
})

describe('B-7: USDCx quoted through USDC is visible', () => {
  it('default sources quote USDCx as USDC', () => {
    expect(usdcxQuotedAsUsdc(loadConfig({}))).toBe(true)
  })
  it('a dedicated USDCx source clears the flag', () => {
    const c = loadConfig({
      ORACLE_SOURCES:
        '{"usdcx":["xreserve","coingecko"],"cc":["coingecko","coinpaprika"],"cbtc":["coingecko","coinpaprika"]}',
      ORACLE_HTTP_SOURCES:
        '[{"name":"xreserve","url":"https://x.example/{id}","ids":{"usdcx":"usdcx"},"pricePath":"p","timePath":"t"}]',
    })
    expect(usdcxQuotedAsUsdc(c)).toBe(false)
  })
})

describe('coinpaprika: one bad id does not drop the other instruments', () => {
  it('quotes the rest and fails only when nothing came back', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('cc-bad')) return new Response('not found', { status: 404 })
      return new Response(
        JSON.stringify({ last_updated: new Date().toISOString(), quotes: { USD: { price: 2 } } }),
      )
    }) as typeof fetch
    const src = coinpaprika({ cc: 'cc-bad', cbtc: 'btc-bitcoin' }, fetchImpl)
    const q = await src.fetch(['cc', 'cbtc'])
    expect(Object.keys(q)).toEqual(['cbtc'])
    await expect(coinpaprika({ cc: 'cc-bad' }, fetchImpl).fetch(['cc'])).rejects.toThrow(/404/)
  })
})

describe('exchange sources: KuCoin and Binance', () => {
  it('read the last price and the exchange time; a pair without an id is skipped', async () => {
    const t = Date.now()
    const fetchImpl = (async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('kucoin')
            ? { code: '200000', data: { last: '2690.5', time: t } }
            : { lastPrice: '2691.00000000', closeTime: t },
        ),
      )) as typeof fetch
    const k = await kucoin({ cbtc: 'BTC-USDT' }, fetchImpl).fetch(['cbtc', 'cc'])
    expect(k).toEqual({ cbtc: { price: '2690.5', observedAt: new Date(t).toISOString() } })
    const b = await binance({ cbtc: 'BTCUSDT' }, fetchImpl).fetch(['cbtc'])
    expect(b.cbtc?.price).toBe('2691.00000000')
  })

  it('Bybit: the price and the time of the last trade, not the response time', async () => {
    const trade = Date.now() - 90_000
    const fetchImpl = (async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('symbol=CCUSDT')
            ? {
                retCode: 0,
                result: { list: [{ symbol: 'CCUSDT', price: '0.11845', time: String(trade) }] },
                time: Date.now(),
              }
            : { retCode: 10001, result: { list: [] }, time: Date.now() },
        ),
      )) as typeof fetch
    const q = await bybit({ cc: 'CCUSDT', cbtc: 'BTCUSDT' }, fetchImpl).fetch(['cc', 'cbtc'])
    expect(q).toEqual({ cc: { price: '0.11845', observedAt: new Date(trade).toISOString() } })
  })

  it('the default sources give every instrument three quotes (review 08.10, item 1)', () => {
    const c = loadConfig({})
    const sources = buildPriceSources(c)
    expect(sources.map((s) => s.name).sort()).toEqual(['binance', 'bybit', 'coingecko', 'kucoin'])
    expect(c.KUCOIN_IDS.cc).toBe('CC-USDT')
    // CC is not on Binance: CoinGecko, KuCoin and Bybit, so one lagging source leaves two
    for (const slot of ['usdcx', 'cc', 'cbtc'] as const) {
      const ids = {
        coingecko: c.COINGECKO_IDS,
        kucoin: c.KUCOIN_IDS,
        binance: c.BINANCE_IDS,
        bybit: c.BYBIT_IDS,
      }
      const quoting = sources.filter((s) => ids[s.name as keyof typeof ids][slot])
      expect(quoting.length, slot).toBeGreaterThanOrEqual(3)
    }
  })
})
