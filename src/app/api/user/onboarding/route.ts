// POST /api/user/onboarding — Drapeau « wizard de première connexion terminé »
// ─────────────────────────────────────────────────────────────────────────────
// Écrit onboardingCompleted (booléen strict) dans User.preferences (Json?) via
// un merge read-modify-write : aucune autre préférence existante n'est écrasée.
// Appelé par OnboardingWizard (finish OU skip) — consommé par SessionUser
// (lib/auth) pour ne plus ré-afficher le wizard.
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

// Booléen STRICT : "true"/1/undefined sont rejetés (pas de coercition).
const onboardingSchema = z.object({
  completed: z.boolean({ message: "« completed » doit être un booléen" }),
})

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

    // Le wizard n'envoie qu'une requête (finish/skip) ; 10/min couvre les
    // reprises de session et la QA sans laisser boucler un client déréglé.
    const limit = rateLimit(`onboarding:${user.id}`, 10)
    if (!limit.ok) return tooManyRequests(limit)

    const parsed = onboardingSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Données invalides" },
        { status: 400 }
      )
    }
    const { completed } = parsed.data

    // Merge read-modify-write : on repart des préférences existantes pour ne
    // toucher qu'à la clé onboardingCompleted (les autres clés survivent).
    const existing = await db.user.findUnique({
      where: { id: user.id },
      select: { preferences: true },
    })
    const preferences = (existing?.preferences as Record<string, unknown> | null) ?? {}

    await db.user.update({
      where: { id: user.id },
      data: { preferences: { ...preferences, onboardingCompleted: completed === true } },
    })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 })
  }
}
