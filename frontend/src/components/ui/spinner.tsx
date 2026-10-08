import { cn } from 'cn'
import { Loader2Icon } from 'lucide-react'

/**
 * Decorative by default: `aria-hidden`, no role. So a spinner inside a button does not get into its
 * name ("Loading Deposit USDC"), and the button reports busy itself via `aria-busy`/`disabled`.
 * For a standalone spinner that reports loading itself, pass `label`: then it
 * becomes `role="status"` with that name.
 */
function Spinner({
  className,
  label,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'aria-label' | 'aria-hidden' | 'role'> & {
  label?: string
}) {
  const a11y = label
    ? ({ role: 'status', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const)
  return <Loader2Icon className={cn('size-4 animate-spin', className)} {...a11y} {...props} />
}

export { Spinner }
