import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * A trend line, drawn as inline SVG.
 *
 * No charting library. Recharts and its peers are 100-200KB before a single
 * pixel is drawn, and this app is used on Ghanaian mobile data where that is a
 * real cost paid by a real person on every load. What is actually needed here
 * is one line and a filled area, which is about forty lines of path maths.
 *
 * Two things a naive version gets wrong and this does not. A flat series , 
 * every value the same, which is what a shop with no sales has, divides by a
 * zero range and produces `NaN` in the path, rendering nothing at all; the
 * range is floored at 1. And a series is drawn across its whole span including
 * the empty days, because a chart that skips the days with no sales makes three
 * sales in a month look like a month of steady trade.
 */
export interface TrendPoint {
  date: string;
  value: number;
}

export default function TrendChart({
  points,
  label,
  formatValue,
  className,
  height = 120,
}: {
  points: TrendPoint[];
  /** Announced to a screen reader in place of the drawing. */
  label: string;
  formatValue: (value: number) => string;
  className?: string;
  height?: number;
}): React.JSX.Element {
  const gradientId = useId();

  if (points.length === 0) {
    return (
      <div
        className={cn('flex items-center justify-center text-sm text-text-muted', className)}
        style={{ height }}
      >
        Nothing to show yet.
      </div>
    );
  }

  const width = 600;
  const padding = { top: 8, bottom: 18, left: 0, right: 0 };
  const plotHeight = height - padding.top - padding.bottom;

  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  // Floored at 1 so a series of zeroes draws a flat line along the bottom
  // rather than dividing by zero and drawing nothing.
  const range = Math.max(max, 1);

  const stepX = points.length > 1 ? width / (points.length - 1) : width;

  const coords = points.map((point, index) => {
    const x = index * stepX;
    const y = padding.top + plotHeight - (point.value / range) * plotHeight;
    return { x, y, point };
  });

  const line = coords.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${padding.top + plotHeight} L0,${padding.top + plotHeight} Z`;

  const peak = coords.reduce((best, current) => (current.point.value > best.point.value ? current : best));

  return (
    <figure className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-auto w-full"
        style={{ height }}
        role="img"
        aria-label={`${label}. Highest: ${formatValue(peak.point.value)} on ${peak.point.date}.`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${gradientId})`} className="text-primary" />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          // Not scaled by preserveAspectRatio="none", which would otherwise
          // stretch the stroke horizontally into a wedge on a wide screen.
          vectorEffect="non-scaling-stroke"
          className="text-primary"
        />

        {max > 0 && (
          <circle cx={peak.x} cy={peak.y} r="3" className="fill-primary" vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      <figcaption className="mt-1 flex justify-between text-2xs text-text-muted">
        <span>{points[0]?.date}</span>
        <span className="fd-figure">Peak {formatValue(peak.point.value)}</span>
        <span>{points.at(-1)?.date}</span>
      </figcaption>
    </figure>
  );
}
