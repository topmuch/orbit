"use client";

// Orbit — Assistant IA conversationnel (streaming)
// Le contexte (agenda + tâches) est injecté côté serveur dans /api/ai/chat.

import { useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { OrbitLogo } from "@/components/orbit/logo"
import { streamAssistant } from "@/lib/api-client"
import type { ChatMessage } from "@/lib/types"
import {
  Send,
  Loader2,
  Trash2,
  Sparkles,
  CalendarClock,
  ListTodo,
  CalendarRange,
  Bot,
} from "lucide-react"

const SUGGESTIONS = [
  {
    icon: CalendarClock,
    label: "Résume ma journée",
    prompt: "Résume ma journée d'aujourd'hui en quelques points, avec les horaires importants.",
  },
  {
    icon: ListTodo,
    label: "Mes priorités",
    prompt: "Quelles sont mes tâches prioritaires ? Propose-moi un ordre de traitement.",
  },
  {
    icon: CalendarRange,
    label: "Organiser demain",
    prompt: "Aide-moi à organiser demain : quels créneaux libres vois-tu dans mon agenda ?",
  },
]

export function AssistantView() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")

  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-scroll + abort propre au démontage
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, streamText])
  useEffect(() => () => abortRef.current?.abort(), [])

  async function send(text: string) {
    const content = text.trim()
    if (!content || streaming) return

    const history = [...messages, { role: "user" as const, content }]
    setMessages(history)
    setInput("")
    setStreaming(true)
    setStreamText("")

    const controller = new AbortController()
    abortRef.current = controller

    try {
      // streamAssistant (src/lib/api-client.ts) délègue à /api/ai/chat,
      // lui-même servi par le micro-service IA (Ollama local en production).
      let acc = await streamAssistant(history, setStreamText, controller.signal)

      if (!acc.trim()) acc = "*(réponse vide — reformulez votre demande)*"
      setMessages((m) => [...m, { role: "assistant", content: acc }])
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: `⚠️ ${(err as Error).message ?? "Erreur de connexion à l'assistant."}`,
          },
        ])
      }
    } finally {
      setStreaming(false)
      setStreamText("")
      abortRef.current = null
    }
  }

  return (
    <div className="flex h-[calc(100vh-11rem)] min-h-[460px] flex-col space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            Assistant Orbit
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-normal text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 animate-live-dot rounded-full bg-emerald-500" aria-hidden />
              en ligne
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connecté à votre agenda et vos tâches — {format(new Date(), "EEEE d MMMM", { locale: fr })}
          </p>
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground"
            onClick={() => setMessages([])}
          >
            <Trash2 className="size-4" aria-hidden />
            Réinitialiser
          </Button>
        )}
      </header>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-border/60 bg-card/70 backdrop-blur-sm">
        {/* Zone messages */}
        <div className="orbit-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          {messages.length === 0 && !streaming ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <OrbitLogo size={64} animated />
              <div>
                <p className="text-lg font-medium">Votre copilote personnel</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Je connais votre agenda et vos tâches. Posez-moi vos questions,
                  je vous aide à organiser vos journées.
                </p>
              </div>
              <div className="mt-2 grid w-full max-w-lg gap-2 sm:grid-cols-3">
                {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
                  <button
                    key={label}
                    onClick={() => send(prompt)}
                    className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-card/60 p-4 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
                  >
                    <Icon className="size-5 text-primary" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <ChatBubble key={i} message={m} />
            ))
          )}

          {streaming && (
            <div className="flex items-start gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Bot className="size-4" aria-hidden />
              </span>
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border/60 bg-muted/50 px-4 py-2.5 text-[15px] leading-relaxed">
                {streamText ? (
                  <>
                    <Markdown components={mdComponents}>{streamText}</Markdown>
                    <span className="caret-blink ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-primary" aria-hidden />
                  </>
                ) : (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    L&apos;assistant réfléchit…
                  </span>
                )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Zone de saisie */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
          className="flex items-end gap-2 border-t border-border/60 p-3"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
            placeholder="Écrivez votre message… (Entrée pour envoyer)"
            rows={1}
            className="max-h-32 min-h-10 flex-1 resize-none"
            aria-label="Message pour l'assistant"
            disabled={streaming}
          />
          <Button
            type="submit"
            size="icon"
            className="size-10 shrink-0"
            disabled={streaming || !input.trim()}
            aria-label="Envoyer le message"
          >
            {streaming ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
          </Button>
        </form>
      </Card>
    </div>
  )
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground">
          {message.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <Sparkles className="size-4" aria-hidden />
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border/60 bg-muted/50 px-4 py-2.5 text-[15px] leading-relaxed">
        <Markdown components={mdComponents}>{message.content}</Markdown>
      </div>
    </div>
  )
}

const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{children}</code>
  ),
}
