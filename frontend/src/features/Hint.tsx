import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Tooltip instead of the `title` attribute: shadcn Tooltip on hover and focus. Without `tip`
 * renders the child as is. A disabled control has no pointer or focus events,
 * so `disabled` wraps it in a focusable span: the reason is visible from the keyboard too.
 */
export function Hint({
  tip,
  disabled = false,
  className,
  children,
}: {
  tip?: ReactNode
  disabled?: boolean
  /** classes of the disabled control's wrapper: layout in the action row */
  className?: string
  children: ReactElement
}) {
  if (!tip) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          <span
            tabIndex={0}
            className={cn(
              'inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              className,
            )}
          >
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent sideOffset={6} className="max-w-64">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}
