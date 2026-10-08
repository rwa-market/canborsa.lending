import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    // Nothing listens on port 9: we check the response when the ledger is unavailable.
    app = await buildApp(loadConfig({ LEDGER_API_URL: 'http://127.0.0.1:9' }), {
      withProtocol: false,
    })
  })

  afterAll(() => app.close())

  it('responds ok and reports that the ledger is unavailable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', ledger: 'unavailable' })
  })
})
