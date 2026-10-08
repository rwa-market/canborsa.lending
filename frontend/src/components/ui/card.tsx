import * as React from 'react'
import { cn } from 'cn'
import { Slot } from 'radix-ui'

/** asChild: a section card (`<section>`) and a heading of the right level (`<h2>`) without an extra wrapper. */
type AsChild = { asChild?: boolean }

function Card({ className, asChild = false, ...props }: React.ComponentProps<'div'> & AsChild) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="card"
      className={cn(
        'flex flex-col gap-6 rounded-2xl border bg-card py-6 text-card-foreground shadow-[0_1px_2px_rgb(15_23_42/0.04),0_8px_24px_-12px_rgb(15_23_42/0.08)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]',
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & AsChild) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  )
}

function CardDescription({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & AsChild) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  )
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
