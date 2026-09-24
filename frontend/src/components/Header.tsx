import type { ConnectionStatus, Portfolio } from "@/lib/types";
import { formatPercent, formatSignedUsd, formatUsd, signClass } from "@/lib/format";

const STATUS_STYLE: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: "bg-up", label: "Live" },
  reconnecting: { color: "bg-accent", label: "Reconnecting" },
  disconnected: { color: "bg-down", label: "Offline" },
};

export function Header({
  portfolio,
  status,
  chatOpen,
  onToggleChat,
}: {
  portfolio: Portfolio | null;
  status: ConnectionStatus;
  chatOpen: boolean;
  onToggleChat: () => void;
}) {
  const total = portfolio?.total_value ?? null;
  const pnl = portfolio?.unrealized_pnl ?? 0;
  const cost = portfolio ? portfolio.positions_value - pnl : 0;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const s = STATUS_STYLE[status];

  return (
    <header className="flex h-14 shrink-0 items-stretch border-b border-line bg-panel">
      <div className="flex items-center gap-2 border-r border-line px-4">
        <span className="h-5 w-1.5 bg-accent" aria-hidden="true" />
        <span className="text-[17px] font-semibold tracking-tight text-ink">
          Fin<span className="text-accent">A</span>lly
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        <Stat label="Portfolio value">
          <span data-testid="header-total-value" className="num text-[20px] font-semibold text-ink">
            {formatUsd(total)}
          </span>
        </Stat>
        <Stat label="Cash">
          <span data-testid="header-cash" className="num text-[15px] font-medium text-ink">
            {formatUsd(portfolio?.cash_balance)}
          </span>
        </Stat>
        <Stat label="Unrealized P&L">
          <span className={`num text-[15px] font-medium ${signClass(pnl)}`}>
            {portfolio ? `${formatSignedUsd(pnl)} (${formatPercent(pnlPct)})` : "—"}
          </span>
        </Stat>
      </div>

      <div className="flex items-center gap-3 border-l border-line px-4">
        <span className="flex items-center gap-2 text-[12px] text-muted" title={`Price stream: ${s.label}`}>
          <span
            data-testid="connection-status"
            data-status={status}
            role="status"
            aria-label={`Price stream ${s.label.toLowerCase()}`}
            className={`h-2.5 w-2.5 rounded-full ${s.color} ${status === "connected" ? "shadow-[0_0_8px_var(--color-up)]" : ""}`}
          />
          {s.label}
        </span>
        <button
          type="button"
          onClick={onToggleChat}
          aria-pressed={chatOpen}
          className="h-8 border border-line px-3 text-[12px] font-medium text-ink hover:border-blue hover:text-blue"
        >
          {chatOpen ? "Hide assistant" : "Ask FinAlly"}
        </button>
      </div>
    </header>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col justify-center border-r border-line px-4">
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </div>
  );
}
