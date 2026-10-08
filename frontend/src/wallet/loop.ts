/**
 * Loop wallet (Five North) via @fivenorth/loop-sdk 0.15.0. Loop does not run our DARs,
 * so the account is custodial (LoopWallet, like EVM in ADR-004): the wallet only signs
 * text with Ed25519 (`provider.signMessage`), the backend verifies the signature by public_key, and
 * the custodian executes the command.
 *
 * Lazy-loaded module (context.tsx): the SDK is needed only once Loop is chosen. SDK network is set
 * once in loop.init, from /config.loop; another network after that is an error; reload needed.
 *
 * How the SDK reports events:
 * - onAccept(provider): sign-in accepted (QR/popup) or session restored from localStorage;
 * - onReject: sign-in refused, ticket revoked or session invalid (onSessionInvalid);
 * - QR dialog closed by clicking the backdrop: the SDK calls nothing, so we watch its DOM node.
 */
import {
  loop,
  PopupClosedError,
  RejectRequestError,
  RequestTimeoutError,
  UnauthorizedError,
} from '@fivenorth/loop-sdk'
import type { LoopSdkNetwork } from './loop-config'

/** SDK provider: the class is not exported from the package, so the type is taken from onAccept */
type Provider = Parameters<NonNullable<Parameters<typeof loop.init>[0]['onAccept']>>[0]
import { normalizeLoopSignature } from './loop-signature'

export class LoopWalletError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'LoopWalletError'
    this.code = code
  }
}

export interface LoopAccount {
  party: string
  publicKey: string
}

/** DOM node of the QR dialog the SDK renders (showQrCode) */
const QR_OVERLAY = '.loop-connect'
/** Connect with no response for longer than this is refused; the SDK ticket lives about as long */
const CONNECT_TIMEOUT_MS = 10 * 60_000

let network: LoopSdkNetwork | null = null
let provider: Provider | null = null
let waiting: { resolve: (p: Provider) => void; reject: (e: Error) => void } | null = null
const listeners = new Set<(party: string | null) => void>()

const cancelled = () => new LoopWalletError('Loop connection cancelled', 'USER_REJECTED')
const account = (p: Provider): LoopAccount => ({ party: p.party_id, publicKey: p.public_key })
const notify = (party: string | null) => {
  for (const cb of listeners) cb(party)
}

/**
 * Wallet window URL. SDK 0.15.0 on DevNet opens wallet.devnet.looptech.io, where sign-in
 * via Google fails: the Loop OAuth client does not know this origin (origin_mismatch, checked
 * 2026-10-02 and 2026-10-05). DevNet uses devnet.cantonloop.com only: the same URL as the fallback
 * too, so neither the "Using the old wallet?" link nor a session saved on the old domain
 * (resolveWalletUrl ignores a URL that is not configured) opens looptech.io. The link itself is
 * hidden in index.css. TestNet and MainNet: as in the SDK; Google works on both domains.
 */
export function walletUrls(net: LoopSdkNetwork): {
  walletUrl?: string
  secondaryWalletUrl?: string
} {
  return net === 'devnet'
    ? {
        walletUrl: 'https://devnet.cantonloop.com',
        secondaryWalletUrl: 'https://devnet.cantonloop.com',
      }
    : {}
}

function setup(net: LoopSdkNetwork) {
  if (network) {
    if (network !== net)
      throw new LoopWalletError('Loop is set up for another network. Reload the page.')
    return
  }
  loop.init({
    appName: 'Canton Lending',
    network: net,
    ...walletUrls(net),
    options: { openMode: 'popup', requestSigningMode: 'popup' },
    onAccept: (p) => {
      const before = provider?.party_id ?? null
      provider = p
      if (waiting) {
        const w = waiting
        waiting = null
        w.resolve(p)
      } else if (before !== p.party_id) notify(p.party_id)
    },
    onReject: () => {
      const had = provider !== null
      provider = null
      if (waiting) {
        const w = waiting
        waiting = null
        w.reject(cancelled())
      } else if (had) notify(null)
    },
  })
  network = net
}

/** The QR dialog closed without sign-in: the SDK does not report this. */
function watchQrClosed(onClosed: () => void): () => void {
  let seen = false
  const check = () => {
    const open = document.querySelector(QR_OVERLAY) !== null
    if (open) seen = true
    // onAccept arrives before the SDK removes the dialog: let it finish
    else if (seen) setTimeout(onClosed, 300)
  }
  const mo = new MutationObserver(check)
  mo.observe(document.body, { childList: true })
  return () => mo.disconnect()
}

/**
 * Connect Loop: a QR dialog or the wallet popup. If the SDK session is already alive, return the
 * account at once. Closed dialog or refusal: USER_REJECTED.
 */
export async function loopConnect(net: LoopSdkNetwork): Promise<LoopAccount> {
  setup(net)
  if (provider) return account(provider)
  if (waiting) waiting.reject(cancelled())
  return new Promise<LoopAccount>((resolve, reject) => {
    let stop = () => {}
    const timer = setTimeout(() => {
      if (waiting === entry) {
        waiting = null
        stop()
        reject(new LoopWalletError('Loop did not answer. Try connecting again.'))
      }
    }, CONNECT_TIMEOUT_MS)
    const entry = {
      resolve: (p: Provider) => {
        clearTimeout(timer)
        stop()
        resolve(account(p))
      },
      reject: (e: Error) => {
        clearTimeout(timer)
        stop()
        reject(e)
      },
    }
    waiting = entry
    stop = watchQrClosed(() => {
      if (waiting === entry && !provider) {
        waiting = null
        entry.reject(cancelled())
      }
    })
    loop.connect().then(
      () => {
        // autoConnect restored the saved session synchronously: onAccept has already been called
        if (provider && waiting === entry) {
          waiting = null
          entry.resolve(provider)
        }
      },
      (e: unknown) => {
        if (waiting === entry) {
          waiting = null
          entry.reject(
            new LoopWalletError(
              `Loop is not reachable: ${e instanceof Error ? e.message : String(e)}`,
            ),
          )
        }
      },
    )
  })
}

/** After a reload: the SDK session from localStorage, if Loop still accepts it. */
export async function loopRestore(net: LoopSdkNetwork): Promise<LoopAccount | null> {
  setup(net)
  if (!provider) await loop.autoConnect().catch(() => undefined)
  return provider ? account(provider) : null
}

/** Account of the connected Loop, or null. */
export const loopAccount = (): LoopAccount | null => (provider ? account(provider) : null)

/**
 * Sign the text with the account key; the party must match the session party. The SDK response
 * is converted to hex (loop-signature.ts).
 */
export async function loopSign(party: string, message: string): Promise<string> {
  const p = provider
  if (!p) throw new LoopWalletError('Your Loop session ended. Connect Loop again.')
  if (p.party_id !== party)
    throw new LoopWalletError('Loop switched to another account. Sign in again.')
  let raw: unknown
  try {
    raw = await p.signMessage(message)
  } catch (e) {
    if (e instanceof RejectRequestError || e instanceof PopupClosedError)
      throw new LoopWalletError('Signature cancelled', 'USER_REJECTED')
    if (e instanceof RequestTimeoutError)
      throw new LoopWalletError('Loop did not answer in time. Nothing was signed.')
    if (e instanceof UnauthorizedError) {
      provider = null
      notify(null)
      throw new LoopWalletError('Your Loop session ended. Connect Loop again.')
    }
    throw new LoopWalletError(e instanceof Error ? e.message : String(e))
  }
  return normalizeLoopSignature(raw, p.public_key)
}

/**
 * The SDK's wallet page where walletUrls sets none, as in @fivenorth/loop-sdk 0.15.0: check it on
 * an SDK upgrade. DevNet always comes from walletUrls.
 */
const SDK_WALLET: Record<Exclude<LoopSdkNetwork, 'devnet'>, string> = {
  testnet: 'https://wallet.testnet.looptech.io',
  mainnet: 'https://wallet.looptech.io',
}

/**
 * Bring the Loop window with the pending request to the front (review 08.10, item 8). The SDK opens
 * its request window under the name "loop-wallet": an open one is only focused, not reloaded, so the
 * request stays on screen. When the popup is gone (closed, blocked, another tab opened it), the
 * wallet page opens in a new one. false: the browser blocked the window.
 */
export function loopOpenWallet(): boolean {
  if (!network) return false
  const url = network === 'devnet' ? walletUrls(network).walletUrl! : SDK_WALLET[network]
  const left = (window.innerWidth - 480) / 2 + window.screenX
  const top = (window.innerHeight - 720) / 2 + window.screenY
  const w = window.open('', 'loop-wallet', `width=480,height=720,left=${left},top=${top}`)
  if (!w) return false
  let blank = false
  try {
    blank = w.location.href === 'about:blank'
  } catch {
    // the wallet's own page: another origin, so it is the open Loop window
  }
  if (blank) w.location.href = url
  w.focus()
  return true
}

/** Account change or end of the Loop session: party or null. */
export function loopSubscribe(cb: (party: string | null) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Sign out of Loop: the SDK revokes the ticket and clears its session. */
export function loopDisconnect() {
  if (waiting) {
    const w = waiting
    waiting = null
    w.reject(cancelled())
  }
  provider = null
  if (network) loop.logout()
}
