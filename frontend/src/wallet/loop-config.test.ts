import { describe, expect, it } from 'vitest'
import { loopConfigOf } from './loop-config.ts'

const custody = 'custody::1220dddddddddddddddd'
const loop = { enabled: true, network: 'devnet', appName: 'Canton Lending', custody }

describe('/config.loop', () => {
  it('takes the SDK network from the server and the signing network from networkId', () => {
    expect(loopConfigOf({ networkId: 'canton:devnet', loop })).toEqual({
      network: 'canton:devnet',
      custody,
      sdkNetwork: 'devnet',
    })
    // server without networkId: the backend substitutes canton
    expect(loopConfigOf({ loop })?.network).toBe('canton')
  })

  it('treats a missing, disabled or incomplete block as Loop off', () => {
    for (const c of [
      undefined,
      {},
      { loop: null },
      { loop: { ...loop, enabled: false } },
      { loop: { ...loop, custody: null } },
      { loop: { ...loop, network: 'local' } },
    ])
      expect(loopConfigOf(c)).toBeNull()
  })
})
