import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "bg-muted animate-pulse rounded-md",
        // Léger shimmer : balayage translucide au-dessus de la pulsation
        "relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:animate-orbit-shimmer after:bg-gradient-to-r after:from-transparent after:via-foreground/10 after:to-transparent after:content-['']",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
