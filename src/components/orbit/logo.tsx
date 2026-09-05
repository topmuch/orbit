"use client";

// Orbit — Logo (planète + anneau, SVG pur)

export function OrbitLogo({ size = 36, animated = false, className = "" }: {
  size?: number
  animated?: boolean
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Logo Orbit"
    >
      <defs>
        <linearGradient id="ol-planet" x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1E4E78" />
          <stop offset="0.55" stopColor="#0A2540" />
          <stop offset="1" stopColor="#06182B" />
        </linearGradient>
        <linearGradient id="ol-ring" x1="4" y1="20" x2="60" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7FE6FF" />
          <stop offset="0.5" stopColor="#00D4FF" />
          <stop offset="1" stopColor="#0074A0" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="13" fill="url(#ol-planet)" />
      <ellipse
        cx="32"
        cy="32"
        rx="24"
        ry="8"
        stroke="url(#ol-ring)"
        strokeWidth="2.6"
        transform="rotate(-18 32 32)"
        className={animated ? "animate-orbit-slow" : undefined}
        style={animated ? { transformOrigin: "32px 32px" } : undefined}
      />
      <circle cx="32" cy="32" r="13" fill="url(#ol-planet)" />
      <ellipse cx="27" cy="27" rx="6" ry="4" fill="#7FE6FF" opacity="0.35" />
      <circle cx="51" cy="17" r="2.2" fill="#FF6B35" />
      <circle cx="10" cy="48" r="1.6" fill="#B8E8F7" opacity="0.7" />
      <circle cx="14" cy="12" r="1.2" fill="#F5F5F7" opacity="0.8" />
    </svg>
  )
}
