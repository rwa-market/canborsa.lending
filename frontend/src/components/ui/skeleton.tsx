import { cn } from 'cn'

/** Loading placeholder: visible to the eye, the screen reader hears "Loading…" once. */
function Skeleton({
  className,
  label = 'Loading…',
  ...props
}: React.ComponentProps<'div'> & { label?: string }) {
  return (
    <div
      data-slot="skeleton"
      role="status"
      className={cn('animate-pulse rounded-md bg-accent', className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
    </div>
  )
}

export { Skeleton }
