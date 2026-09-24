import type { Position } from "@/lib/types";
import {
  formatPercent,
  formatPrice,
  formatQuantity,
  formatSignedUsd,
  formatUsd,
  signClass,
} from "@/lib/format";
import { Panel } from "./Panel";

const TH = "px-3 py-1.5 font-normal";
const TD = "px-3 py-1.5";

export function PositionsTable({
  positions,
  onSelect,
}: {
  positions: Position[];
  onSelect?: (ticker: string) => void;
}) {
  return (
    <Panel
      title="Positions"
      aside={<span className="num text-[11px] text-faint">{positions.length} open</span>}
      className="h-full"
      bodyClassName="overflow-auto"
    >
      <table data-testid="positions-table" className="num w-full border-collapse text-right">
        <thead className="sticky top-0 bg-panel text-[11px] text-faint">
          <tr className="border-b border-line">
            <th className={`${TH} text-left`}>Symbol</th>
            <th className={TH}>Qty</th>
            <th className={TH}>Avg cost</th>
            <th className={TH}>Last</th>
            <th className={TH}>Market value</th>
            <th className={TH}>Unrealized P&amp;L</th>
            <th className={TH}>Change</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr
              key={p.ticker}
              data-testid={`position-row-${p.ticker}`}
              onClick={() => onSelect?.(p.ticker)}
              className="cursor-pointer border-b border-line/60 hover:bg-raised"
            >
              <td className={`${TD} text-left font-semibold text-ink`}>{p.ticker}</td>
              <td className={TD}>{formatQuantity(p.quantity)}</td>
              <td className={`${TD} text-muted`}>{formatPrice(p.avg_cost)}</td>
              <td className={TD}>{formatPrice(p.current_price)}</td>
              <td className={TD}>{formatUsd(p.market_value)}</td>
              <td className={`${TD} ${signClass(p.unrealized_pnl)}`}>
                {formatSignedUsd(p.unrealized_pnl)}
              </td>
              <td className={`${TD} ${signClass(p.pnl_percent)}`}>{formatPercent(p.pnl_percent)}</td>
            </tr>
          ))}
          {positions.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-muted">
                You don&apos;t hold anything yet. Place a market order to open a position.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}
