// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · utilitaires partagés
// ═══════════════════════════════════════════════════════════════════════════

/** Extraction tolérante d'un objet JSON dans une réponse LLM (fencing markdown, texte autour…). */
export function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"]
const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]

/** Date/heure lisible en français (le micro-service n'embarque pas date-fns). */
export function formatFrLong(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${JOURS[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** Hash FNV-1a 32 bits → hex (clé de cache compacte). */
export function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Tronque un instant à l'heure (pour des clés de cache stables). */
export function hourBucket(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`
}

/**
 * Sanitization d'une entrée avant envoi à l'IA : remplace les caractères de
 * contrôle (sauf \t \n), supprime les astérisques de balisage Markdown
 * parasites courants dans le HTML nettoyé, tronque à `max`.
 */
export function sanitize(raw: unknown, max: number): string {
  if (typeof raw !== "string") return ""
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, max)
}

/** Nombre de mots d'un texte (comptage simple, séparateurs espacés). */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Borne une valeur numérique dans [min, max] (défaut si non numérique). */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
