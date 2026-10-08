import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { Slot } from 'radix-ui'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,filter,scale] duration-200 touch-manipulation active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(10_30_90/0.25)] hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline:
          'border border-border bg-card text-foreground hover:bg-accent dark:border-input dark:bg-transparent dark:hover:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-foreground underline underline-offset-4 hover:text-muted-foreground',
      },
      size: {
        // One size for all action buttons: like Supply in the asset table
        default: 'h-8 min-w-24 gap-1.5 px-4 has-[>svg]:px-3.5',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 min-w-24 gap-1.5 px-4 has-[>svg]:px-3.5',
        lg: 'h-11 rounded-md px-6 text-[15px] has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-9',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
