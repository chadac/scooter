import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const errorStateVariants = cva(
  "flex flex-col gap-2 text-sm",
  {
    variants: {
      variant: {
        default: "text-destructive",
        boxed: "rounded-lg border border-destructive/40 bg-destructive/10 p-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

interface ErrorStateProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof errorStateVariants> {
  title?: string
  error?: string | Error
}

function ErrorState({
  className,
  variant,
  title,
  error,
  children,
  ...props
}: ErrorStateProps) {
  const errorMessage = error instanceof Error ? error.message : error

  return (
    <div className={cn(errorStateVariants({ variant, className }))} role="alert" {...props}>
      {title && <p className="font-medium text-destructive dark:text-destructive">{title}</p>}
      {errorMessage && <p className="text-destructive dark:text-destructive">{errorMessage}</p>}
      {children}
    </div>
  )
}

export { ErrorState, errorStateVariants }
