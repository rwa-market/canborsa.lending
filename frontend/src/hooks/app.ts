import type { TokenSymbol, WalletBalances } from '@lending/shared'
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { humanize, useConfig } from '@/hooks/data'
import { api, ApiError, queryKeys } from '@/lib/api'
import { formatAmount } from '@/lib/amount'
import { tokenDigits } from '@/lib/tokens'
import { floorTo } from '@/lib/decimal'
import { acceptTransferCommand } from '@/wallet/faucet'
import { useWallet, walletNetworkVerdict } from '@/wallet/context'
import { totalOf } from '@/wallet/holdings'
import { expectedNetwork } from '@/wallet/network'

/** Role of the logged-in party: service roles see their own pages instead of the user ones. */
export function useRoles() {
  const wallet = useWallet()
  const roles = useConfig().data?.roles
  const party = wallet.signedIn ? wallet.party : null
  const isGuardian = !!party && party === roles?.guardian
  const isTreasury = !!party && party === roles?.treasury
  // review 03.10, item 9: every approved liquidator, as the backend admits them, not only the first
  const liquidators = roles ? (roles.liquidators ?? [roles.liquidator]) : []
  const isLiquidator = !!party && liquidators.includes(party)
  const isBackstop = !!party && party === roles?.backstop
  return {
    isGuardian,
    isTreasury,
    isLiquidator,
    isBackstop,
    isService: isGuardian || isTreasury || isLiquidator || isBackstop,
  }
}

/**
 * Council (GET /governance): the backend returns it to council members, treasury, the operator and new
 * members of an open rotation, 403 to everyone else. Membership is not in /config, so we ask
 * the server; guardian, liquidator and backstop are separate parties (rule 5), we do not send for them.
 */
export function useGovernance() {
  const wallet = useWallet()
  const roles = useRoles()
  const party = wallet.signedIn ? wallet.party : null
  return useQuery({
    queryKey: queryKeys.governance(party),
    queryFn: api.governance,
    enabled: !!party && !roles.isGuardian && !roles.isLiquidator && !roles.isBackstop,
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data ? 15_000 : false),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  })
}

/**
 * Wallet on another or unknown network: operations are blocked (T3.2.1, F-4).
 * Fail-closed: an undeclared network also blocks. The same check is in submit.
 */
export function useNetworkBlocked() {
  const wallet = useWallet()
  const config = useConfig().data
  const expected = expectedNetwork(config)
  if (!wallet.kind || !config) return { blocked: false, reason: null, expected }
  const v = walletNetworkVerdict(config, wallet.kind)
  return { blocked: !v.ok, reason: v.ok ? null : v.reason, expected }
}

/** Free balance: Loop from the backend (share at the custodian); node wallet from its ledger holdings (F-10). */
export function useWalletBalances() {
  const wallet = useWallet()
  const instruments = useConfig().data?.instruments
  return useQuery<WalletBalances>({
    queryKey: queryKeys.wallet(wallet.party),
    queryFn: async () => {
      // Loop: the backend computes the balance, the LoopWallet account's share of the custodian's holdings
      if (wallet.kind === 'loop') return api.wallet(wallet.party!)
      const entries = await Promise.all(
        (
          [
            ['USDCx', instruments!.usdcx],
            ['CC', instruments!.cc],
            ['CBTC', instruments!.cbtc],
          ] as const
        ).map(async ([symbol, instrument]) => {
          const hs = (await wallet.walletHoldings(instrument)) ?? []
          // Tokens have 10 decimals: the balance for the Max button is truncated down to the amount field precision
          return [symbol, floorTo(totalOf(hs), 10)] as const
        }),
      )
      return Object.fromEntries(entries) as WalletBalances
    },
    enabled:
      wallet.party !== null &&
      wallet.signedIn &&
      (wallet.kind === 'loop' || (wallet.kind === 'node' && !!instruments)),
    refetchInterval: 15_000,
  })
}

/**
 * Network name for the header and footer: from the backend networkId. For a local stack without a network
 * it is null: the UI does not show the technical environment, only real networks.
 */
export function useNetworkLabel() {
  const config = useConfig().data
  // /config.network.name from the backend (devnet|testnet|mainnet), otherwise by networkId
  const id = `${config?.network?.name ?? ''} ${expectedNetwork(config) ?? ''}`
  const name: string | null = /mainnet/i.test(id)
    ? 'MainNet'
    : /testnet/i.test(id)
      ? 'TestNet'
      : /devnet/i.test(id)
        ? 'DevNet'
        : null
  return { name, testTokens: !!config?.testFaucet }
}

/**
 * Test token faucet (TEST_FAUCET): the backend creates a transfer offer from the registry,
 * the wallet accepts it after the verifyPrepared check ('accept-transfer').
 */
/**
 * Test token faucet. Requests for different tokens run in parallel: the button is disabled and
 * spins only for the token being credited now (`isPendingFor`).
 */
export function useFaucet() {
  const wallet = useWallet()
  const qc = useQueryClient()
  // all pending faucet requests in this tab, not just the last mutate call
  const pending = useMutationState({
    filters: { mutationKey: ['faucet'], status: 'pending' },
    select: (m) => m.state.variables as TokenSymbol,
  })
  const mutation = useMutation({
    mutationKey: ['faucet'],
    mutationFn: async (symbol: TokenSymbol) => {
      if (!wallet.party) throw new Error('Connect a wallet first')
      const offer = await api.testFaucet(symbol)
      // Loop: the custodian has already accepted the transfer and credited it to the wallet account
      if (offer.received) return offer
      // A custodial account has nothing to accept the transfer with: the wallet does not hold our tokens
      if (wallet.kind !== 'node')
        throw new Error('The faucet did not credit your wallet. Try again in a minute.')
      await wallet.submit(
        acceptTransferCommand(wallet.party, offer.offerCid),
        {
          kind: 'accept-transfer',
          offerCid: offer.offerCid,
          instrument: offer.instrument,
          amount: offer.amount,
          symbol: offer.symbol,
        },
        `faucet-accept-${offer.offerCid}`,
      )
      return offer
    },
    onSuccess: (o) => {
      toast.success(`Received ${formatAmount(o.amount, tokenDigits(o.symbol))} ${o.symbol}`)
      void qc.invalidateQueries({ queryKey: queryKeys.wallet(wallet.party) })
      void qc.invalidateQueries({ queryKey: ['preview'] })
    },
    onError: (e) => toast.error(humanize(e instanceof Error ? e.message : String(e))),
  })
  return { ...mutation, isPendingFor: (symbol: TokenSymbol) => pending.includes(symbol) }
}
