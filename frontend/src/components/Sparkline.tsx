import type { PricePoint } from "@/lib/priceStore";

const MAX_POINTS = 120;

export function sparklinePath(points: PricePoint[], width: number, height: number): string {
  const pts = points.slice(-MAX_POINTS);
  if (pts.length < 2) return "";
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  return pts
    .map((p, i) => {
      const x = i * step;
      const y = height - 1 - ((p.value - min) / span) * (height - 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function Sparkline({
  points,
  width = 72,
  height = 22,
}: {
  points: PricePoint[] | undefined;
  width?: number;
  height?: number;
}) {
  const d = points ? sparklinePath(points, width, height) : "";
  const pts = points?.slice(-MAX_POINTS) ?? [];
  const rising = pts.length > 1 && pts[pts.length - 1].value >= pts[0].value;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block overflow-visible"
      aria-hidden="true"
    >
      {d ? (
        <path
          d={d}
          fill="none"
          stroke={rising ? "var(--color-up)" : "var(--color-down)"}
          strokeWidth={1.25}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <line
          x1={0}
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--color-line)"
          strokeDasharray="2 3"
        />
      )}
    </svg>
  );
}
