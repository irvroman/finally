"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatActions, ChatMessage, ChatResponse } from "@/lib/types";
import { formatPrice, formatQuantity } from "@/lib/format";

export function describeActions(actions: ChatActions | null | undefined) {
  if (!actions) return [];
  const out: { key: string; ok: boolean; text: string }[] = [];
  (actions.watchlist_changes ?? []).forEach((w, i) => {
    const verb = w.action === "add" ? "Added" : "Removed";
    const prep = w.action === "add" ? "to" : "from";
    out.push({
      key: `w${i}`,
      ok: w.status === "executed",
      text:
        w.status === "executed"
          ? `${verb} ${w.ticker} ${prep} watchlist`
          : `Couldn't ${w.action} ${w.ticker}: ${w.error ?? "failed"}`,
    });
  });
  (actions.trades ?? []).forEach((t, i) => {
    const qty = formatQuantity(t.quantity);
    out.push({
      key: `t${i}`,
      ok: t.status === "executed",
      text:
        t.status === "executed"
          ? `${t.side === "buy" ? "Bought" : "Sold"} ${qty} ${t.ticker}${t.price != null ? ` at $${formatPrice(t.price)}` : ""}`
          : `Couldn't ${t.side} ${qty} ${t.ticker}: ${t.error ?? "failed"}`,
    });
  });
  return out;
}

let localId = 0;
const nextId = () => `local-${++localId}`;

export function ChatPanel({
  loadHistory,
  send,
  onActions,
  onCollapse,
}: {
  loadHistory: () => Promise<ChatMessage[]>;
  send: (message: string) => Promise<ChatResponse>;
  /** Called after a reply that executed at least one trade or watchlist change. */
  onActions?: () => void;
  onCollapse?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadHistory()
      .then((history) => {
        // Keep anything sent while history was loading.
        if (!cancelled) setMessages((current) => [...history, ...current]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || loading) return;
    const now = new Date().toISOString();
    setMessages((m) => [
      ...m,
      { id: nextId(), role: "user", content: text, actions: null, created_at: now },
    ]);
    setDraft("");
    setLoading(true);
    try {
      const res = await send(text);
      const actions = { trades: res.trades ?? [], watchlist_changes: res.watchlist_changes ?? [] };
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          role: "assistant",
          content: res.message,
          actions,
          created_at: new Date().toISOString(),
          error: Boolean(res.error),
        },
      ]);
      const executed = [...actions.trades, ...actions.watchlist_changes].some(
        (a) => a.status === "executed",
      );
      if (executed) onActions?.();
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          role: "assistant",
          content: err instanceof Error ? err.message : "The assistant didn't respond. Try again.",
          actions: null,
          created_at: new Date().toISOString(),
          error: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside
      data-testid="chat-panel"
      aria-label="AI assistant"
      className="flex h-full min-h-0 flex-col border border-line bg-panel"
    >
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-[12px] font-semibold tracking-wide text-muted">
          FinAlly assistant
        </h2>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse assistant"
            className="text-[16px] leading-none text-faint hover:text-ink"
          >
            ›
          </button>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !loading && (
          <div className="space-y-2 text-muted">
            <p>Ask about your portfolio, or tell me what to trade.</p>
            <ul className="space-y-1 text-[12px] text-faint">
              <li>&ldquo;How concentrated is my portfolio?&rdquo;</li>
              <li>&ldquo;Buy 5 NVDA&rdquo;</li>
              <li>&ldquo;Add PYPL to my watchlist&rdquo;</li>
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {loading && (
          <div
            data-testid="chat-loading"
            role="status"
            aria-label="Assistant is thinking"
            className="dot-pulse flex items-center gap-1 text-blue"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          </div>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-line p-2">
        <div className="flex gap-1.5">
          <textarea
            data-testid="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            placeholder="Message FinAlly"
            aria-label="Message the assistant"
            className="min-w-0 flex-1 resize-none border border-line bg-bg px-2 py-1.5 text-ink placeholder:text-faint focus:border-blue focus:outline-none"
          />
          <button
            data-testid="chat-send"
            type="submit"
            disabled={loading || !draft.trim()}
            className="self-stretch bg-purple px-3 font-semibold text-white hover:bg-purple-hover disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const actions = describeActions(message.actions);
  return (
    <div
      data-testid={isUser ? "chat-message-user" : "chat-message-assistant"}
      className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
    >
      <p
        className={`max-w-[92%] whitespace-pre-wrap px-2.5 py-1.5 leading-snug ${
          isUser
            ? "bg-raised text-ink"
            : message.error
              ? "border-l-2 border-down text-ink"
              : "border-l-2 border-blue text-ink"
        }`}
      >
        {message.content}
      </p>
      {actions.map((a) => (
        <span
          key={a.key}
          data-testid="chat-action"
          data-status={a.ok ? "executed" : "failed"}
          className={`num ml-2.5 border px-2 py-0.5 text-[12px] ${
            a.ok ? "border-up/40 text-up" : "border-down/40 text-down"
          }`}
        >
          {a.ok ? "✓ " : "✕ "}
          {a.text}
        </span>
      ))}
    </div>
  );
}
