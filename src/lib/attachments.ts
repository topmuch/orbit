// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Stockage des pièces jointes (disque local) — serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// Les fichiers ne sont JAMAIS mis en base (seules les métadonnées le sont :
// model EmailAttachment). Le binaire vit dans storage/attachments/<emailId>/
// sous un nom ALÉATOIRE — le nom fourni par l'expéditeur (potentiellement
// piégé : traversal, caractères exotiques) n'est jamais utilisé comme chemin.
//
// Garanties :
//   • limite de taille (15 Mo) et de nombre par email (10) ;
//   • lecture contrôlée : readAttachmentFile vérifie que le chemin demandé
//     reste DANS storage/attachments (anti-traversal) ;
//   • suppression en cascade avec l'email (deleteEmailAttachments).
//
// Volume Docker : monter ./storage (cf. docs/email-imap-guide.md).
// ═══════════════════════════════════════════════════════════════════════════

import "server-only"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises"
import { join, normalize, sep } from "node:path"
import { createHash } from "node:crypto"

/** Racine du stockage (chemin absolu, hors du bundle Next). */
const STORAGE_ROOT = join(process.cwd(), "storage", "attachments")

/** Bornes de protection. */
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024 // 15 Mo
export const ATTACHMENT_MAX_COUNT = 10

/** Entrée de pièce jointe extraite par mailparser. */
export interface RawAttachment {
  filename?: string
  contentType?: string
  size?: number
  /** Content-ID MIME — false quand absent (mailparser) */
  contentId?: string | false
  /** true quand l'image fait partie du corps (related) plutôt qu'une PJ. */
  related?: boolean
  content?: Buffer
}

/** Résultat de l'enregistrement (métadonnées à persister en base). */
export interface StoredAttachment {
  filename: string
  contentType: string
  size: number
  contentId: string | null
  isInline: boolean
  storagePath: string
}

/** Nom de fichier sûr : remplace les séparateurs/caractères exotiques. */
function safeFilename(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "")
    .replace(/[/\\]+/g, "_") // séparateurs → underscore (anti-traversal)
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[^\w\-.,() ]/g, "_")
    .trim()
  const final = cleaned.length ? cleaned.slice(0, 120) : ""
  return final || fallback
}

/**
 * Enregistre une pièce jointe sur disque. Retourne null si :
 *   • contenu absent / trop grand (métadonnée conservée côté sync, fichier ignoré) ;
 *   • l'écriture échoue (jamais d'échec de sync pour une PJ).
 */
export async function saveAttachment(
  emailId: string,
  raw: RawAttachment,
  index: number
): Promise<StoredAttachment | null> {
  if (!raw.content || !raw.content.length) return null
  if (raw.content.length > ATTACHMENT_MAX_BYTES) return null

  const dir = join(STORAGE_ROOT, emailId)
  // 16 octets aléatoires hex : jamais le nom client dans le chemin disque.
  const random = randomBytes(16).toString("hex")
  const filename = safeFilename(raw.filename, `piece-jointe-${index + 1}`)
  const diskName = `${random}__${filename}`
  const absPath = join(dir, diskName)
  const storagePath = `${emailId}/${diskName}` // chemin relatif stocké en base

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(absPath, raw.content)
    return {
      filename,
      contentType: (raw.contentType ?? "application/octet-stream").split(";")[0].trim(),
      size: raw.content.length,
      contentId: raw.contentId ? raw.contentId.replace(/[<>]/g, "").trim() || null : null,
      isInline: Boolean(raw.related),
      storagePath,
    }
  } catch {
    return null
  }
}

/**
 * Lit un fichier de pièce jointe — avec garde anti-traversal : le chemin
 * normalisé DOIT rester sous storage/attachments. Retourne null si absent.
 */
export async function readAttachmentFile(storagePath: string): Promise<Buffer | null> {
  const normalized = normalize(storagePath)
  if (normalized.startsWith("..") || normalized.includes(`..${sep}`)) return null
  const abs = join(STORAGE_ROOT, normalized)
  if (!abs.startsWith(normalize(STORAGE_ROOT) + sep)) return null
  try {
    return await readFile(abs)
  } catch {
    return null
  }
}

/** Supprime TOUS les fichiers d'un email (suppression définitive). */
export async function deleteEmailAttachments(emailId: string): Promise<void> {
  await rm(join(STORAGE_ROOT, emailId), { recursive: true, force: true }).catch(() => {})
}

/** Supprime un fichier précis (nettoyage d'orphelin). */
export async function deleteOneAttachment(storagePath: string): Promise<void> {
  const normalized = normalize(storagePath)
  if (normalized.startsWith("..") || normalized.includes(`..${sep}`)) return
  const abs = join(STORAGE_ROOT, normalized)
  if (!abs.startsWith(normalize(STORAGE_ROOT) + sep)) return
  await unlink(abs).catch(() => {})
}

/** Empreinte SHA-256 (QA/audit : vérifier l'intégrité d'un fichier stocké). */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}
