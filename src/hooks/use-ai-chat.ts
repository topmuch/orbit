"use client"

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — useAIChat : état du chat assistant (streaming)
// ───────────────────────────────────────────────────────────────────────────
// Encapsule la conversation avec /api/ai/chat (flux texte) : historique,
// streaming token par token, abort (bouton/démontage), erreurs rendues dans
// la conversation. Le contexte utilisateur (agenda + tâches) est injecté
// côté serveur — ce hook n'envoie que l'historique de messages.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from "react"
import { streamAssistant } from "@/lib/api-client"
import type { ChatMessage } from "@/lib/types"

export interface UseAIChat {
  /** Historique complet (inclut les messages d'erreur éventuels). */
  messages: ChatMessage[]
  /** true pendant la génération d'une réponse. */
  streaming: boolean
  /** Texte partiel de la réponse en cours (token par token). */
  streamText: string
  /** Dernière erreur réseau (null sinon) — aussi rendue dans messages. */
  error: string | null
  /** Envoie un message utilisateur et streame la réponse. */
  sendMessage: (content: string) => Promise<void>
  /** Interrompt la génération en cours et vide la conversation. */
  clearChat: () => void
}

export function useAIChat(): UseAIChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const historyRef = useRef<ChatMessage[]>([])

  // Abort propre au démontage du composant hôte.
  useEffect(() => () => abortRef.current?.abort(), [])

  const sendMessage = useCallback(async (content: string) => {
    const text = content.trim()
    if (!text || busyRef.current) return

    const history: ChatMessage[] = [...historyRef.current, { role: "user", content: text }]
    historyRef.current = history
    setMessages(history)
    setError(null)
    setStreaming(true)
    setStreamText("")

    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true

    try {
      let acc = await streamAssistant(history, setStreamText, controller.signal)
      if (!acc.trim()) acc = "*(réponse vide — reformulez votre demande)*"
      const done: ChatMessage[] = [...historyRef.current, { role: "assistant", content: acc }]
      historyRef.current = done
      setMessages(done)
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const message = (err as Error).message || "Erreur de connexion à l'assistant."
        setError(message)
        const failed: ChatMessage[] = [
          ...historyRef.current,
          { role: "assistant", content: `⚠️ ${message}` },
        ]
        historyRef.current = failed
        setMessages(failed)
      }
    } finally {
      busyRef.current = false
      setStreaming(false)
      setStreamText("")
      abortRef.current = null
    }
  }, [])

  const clearChat = useCallback(() => {
    abortRef.current?.abort()
    historyRef.current = []
    setMessages([])
    setStreamText("")
    setError(null)
  }, [])

  return { messages, streaming, streamText, error, sendMessage, clearChat }
}
