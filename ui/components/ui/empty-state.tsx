import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const emptyStateVariants = cva(
  "flex flex-col items-center justify-center text-center text-muted-foreground",
  {
    variants: {
      variant: {
        default: "py-8",
        compact: "py-4",
        boxed: "rounded-lg border bg-muted/30 p-8",
      },
      size: {
        sm: "text-xs",
        default: "text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

interface EmptyStateProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof emptyStateVariants> {
  icon?: React.ReactNode
  title?: string
  description?: string
}

function EmptyState({
  className,
  variant,
  size,
  icon,
  title,
  description,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn(emptyStateVariants({ variant, size, className }))} {...props}>
      {icon && <div className="mb-2 text-muted-foreground/50">{icon}</div>}
      {title && <p className="font-medium text-foreground">{title}</p>}
      {description && <p className="mt-1">{description}</p>}
      {children}
    </div>
  )
}

export { EmptyState, emptyStateVariants }
