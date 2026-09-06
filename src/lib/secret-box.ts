// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Chiffrement des identifiants (secret-box) — usage serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// AES-256-GCM : algorithme authentifié (toute altération de la valeur stockée
// est détectée à la lecture). La clé est dérivée du secret d'application
// AUTH_SECRET (déjà requis pour les sessions) — AUCUN secret supplémentaire
// à gérer, et le mot de passe IMAP n'est JAMAIS stocké en clair.
//
// Format stocké : "v1:<iv base64>:<tag base64>:<chiffré base64>"
//   v1  = version du format (rotation future possible)
//   iv  = vecteur d'initialisation aléatoire (96 bits) — unique par valeur
//   tag = code d'authentification (128 bits)
//
// Ne JAMAIS exposer ce module côté client ("server-only" ci-dessous) :
// la clé de déchiffrement ne doit exister que sur le serveur.
// ═══════════════════════════════════════════════════════════════════════════

import "server-only"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const VERSION = "v1"
const IV_BYTES = 12 // 96 bits — recommandé pour GCM
const TAG_BYTES = 16 // 128 bits

/** Dérivation de clé : SHA-256 de AUTH_SECRET → 32 octets (AES-256). */
function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET manquant dans .env")
  return createHash("sha256").update(`${secret}|orbit:secret-box:v1`).digest()
}

/** Chiffre un secret (mot de passe IMAP…) → chaîne stockable en base. */
export function encryptSecret(plain: string): string {
  if (!plain) throw new Error("Secret vide")
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== TAG_BYTES) throw new Error("Tag GCM invalide")
  return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":")
}

/** Déchiffre une valeur produite par encryptSecret. Lève si altérée/invalide. */
export function decryptSecret(stored: string): string {
  const parts = stored.split(":")
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Format de secret chiffré invalide")
  }
  const [, ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, "base64")
  const tag = Buffer.from(tagB64, "base64")
  const data = Buffer.from(dataB64, "base64")
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Paramètres GCM invalides")
  }
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

/** Diagnostic (jamais de secret en clair) : format reconnu ? */
export function isEncryptedSecret(stored: string): boolean {
  const parts = stored.split(":")
  return parts.length === 4 && parts[0] === VERSION
}
