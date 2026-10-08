import type { MarketId, Operation } from '@lending/shared'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { useWallet } from '@/wallet/context'

interface ActionState {
  op: Operation
  marketId: MarketId
  open: boolean
  /** Open the operation dialog from the dashboard buttons; marketId for collateral operations */
  openAction: (op: Operation, marketId?: MarketId) => void
  setOpen: (open: boolean) => void
}

const ActionContext = createContext<ActionState | null>(null)

export function ActionProvider({ children }: { children: ReactNode }) {
  const [op, setOp] = useState<Operation>('supply')
  const [marketId, setMarketId] = useState<MarketId>('CC')
  const [open, setOpen] = useState(false)
  const openAction = useCallback((next: Operation, m?: MarketId) => {
    setOp(next)
    if (m) setMarketId(m)
    setOpen(true)
  }, [])
  const value = useMemo(
    () => ({ op, marketId, open, openAction, setOpen }),
    [op, marketId, open, openAction],
  )
  return <ActionContext.Provider value={value}>{children}</ActionContext.Provider>
}

export function useAction(): ActionState {
  const ctx = useContext(ActionContext)
  if (!ctx) throw new Error('useAction outside ActionProvider')
  return ctx
}

/**
 * Start an operation from a button: without a signed-in wallet it connects Loop instead. The button
 * is never disabled for a missing balance: the dialog says what is missing and what to do.
 */
export function useStartAction() {
  const wallet = useWallet()
  const { openAction } = useAction()
  const signedIn = !!wallet.party && wallet.signedIn
  return (op: Operation, marketId?: MarketId) => () =>
    signedIn ? openAction(op, marketId) : void wallet.connectLoop()
}
