import { ArrowClockwiseIcon, ArrowSquareOutIcon, SealCheckIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useWallet } from '@/wallet/context'
import type { SignSummary } from '@/wallet/verify'
import { useAction } from './action'

/**
 * "You will sign": what the verified command does, in words (F-1). Shown while
 * the wallet window is open, so the user can compare it with the wallet's signing screen.
 */
export function SigningSummary({ summary }: { summary: SignSummary }) {
  return (
    <div className="flex flex-col gap-2">
      {summary.retry && (
        <Alert aria-label="Why again" variant="warning">
          <ArrowClockwiseIcon weight="bold" />
          <AlertDescription>{summary.retry}</AlertDescription>
        </Alert>
      )}
      <Alert aria-label="You are signing" aria-live="polite" variant="info">
        <SealCheckIcon weight="fill" />
        <AlertTitle className="font-semibold">You are signing: {summary.title}</AlertTitle>
        <AlertDescription>
          <ul className="flex list-disc flex-col gap-0.5 pl-5">
            {summary.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {summary.message && (
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-muted-foreground">
                Exact text your wallet signs:
              </figcaption>
              <pre
                aria-label="Text to sign"
                className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground"
              >
                {summary.message}
              </pre>
            </figure>
          )}
          <p className="text-xs text-muted-foreground">
            Checked by this app. Approve in your wallet only if it shows the same.
          </p>
          {/* Loop signs text in its own window, which hides easily behind this one (review 08.10, item 8) */}
          {summary.message && <OpenLoop />}
        </AlertDescription>
      </Alert>
    </div>
  )
}

/** Where the Loop request is and how to get to it: the window opens separately from this tab. */
function OpenLoop() {
  const { kind, openLoopWallet } = useWallet()
  const [blocked, setBlocked] = useState(false)
  if (kind !== 'loop') return null
  return (
    <div className="mt-1 flex flex-col gap-1.5 border-t pt-2.5">
      <p className="text-xs text-muted-foreground">
        Loop asks in its own window. Do not see it? Bring it to the front; the request waits there
        until you approve or reject it.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => void openLoopWallet().then((ok) => setBlocked(!ok))}
      >
        <ArrowSquareOutIcon weight="bold" data-icon="inline-start" />
        Open Loop
      </Button>
      {blocked && (
        <p role="status" className="text-xs text-warning-foreground">
          The browser blocked the Loop window. Allow pop-ups for this site and press Open Loop
          again.
        </p>
      )}
    </div>
  )
}

/** The same summary outside the operation dialog: login, admin, treasury, council. */
export function SigningNotice() {
  const { signing } = useWallet()
  const { open } = useAction()
  if (!signing || open) return null
  return (
    // bottom right, where the toasts are: the middle of the screen stays readable while Loop is open
    <div className="fixed right-4 bottom-4 z-50 w-[min(32rem,calc(100%-2rem))] shadow-lg">
      <div className="rounded-lg bg-card">
        <SigningSummary summary={signing} />
      </div>
    </div>
  )
}

/**
 * Node wallet: the node signs with its token at once, so a verified command waits here for an
 * explicit Confirm (review 03.10, item 18): a purchase or a reserves transfer is never one click.
 */
export function NodeConfirm() {
  const { confirming, answerConfirm } = useWallet()
  return (
    <Dialog open={!!confirming} onOpenChange={(open) => !open && answerConfirm(false)}>
      <DialogContent aria-describedby="node-confirm-note">
        <DialogTitle>Confirm with your node account</DialogTitle>
        <DialogDescription id="node-confirm-note">
          Your Canton node signs this for your party as soon as you confirm. Check it first.
        </DialogDescription>
        {confirming && <SigningSummary summary={confirming} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => answerConfirm(false)}>
            Cancel
          </Button>
          <Button autoFocus onClick={() => answerConfirm(true)}>
            Confirm and sign
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
