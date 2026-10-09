import { useId, useState } from 'react';
import { formatDate, formatPKR } from '@pos/shared';

export interface DayPoint {
  date: string;
  billCount: number;
  netSales: number;
  /** Null when the signed-in user may not see profit. */
  grossProfit: number | null;
}

const PLOT_HEIGHT = 176;
const AXIS_GUTTER = 68;
const MAX_BAR_WIDTH = 26;

/**
 * Takings per day.
 *
 * One axis, one unit. Where profit is visible each bar splits into what the
 * goods cost and what the shop kept, and those two add up to the day's takings —
 * so the stack is honest, rather than two scales pretending to share a chart.
 *
 * The two hues are the shop's own: circuit-board green for money kept, brass for
 * cost. That pair was run through the palette validator — adjacent CVD ΔE 10.9,
 * normal-vision ΔE 18.0, both clear of the floor.
 *
 * Built from HTML rather than a stretched SVG viewBox, so a bar stays a thin
 * mark whether the window is 1100px or 2400px wide.
 */
export function DailySalesChart({ days }: { days: DayPoint[] }): React.JSX.Element | null {
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (days.length === 0) return null;

  const showProfit = days.some((day) => day.grossProfit !== null);
  const peak = Math.max(...days.map((day) => day.netSales), 1);
  const ticks = niceTicks(peak);
  const ceiling = ticks[ticks.length - 1] ?? peak;
  const active = hover !== null ? days[hover] : null;

  return (
    <figure className="m-0">
      <figcaption className="sr-only" id={titleId}>
        Takings for each day in the selected period
      </figcaption>

      {showProfit && (
        <div className="mb-3 flex items-center gap-4">
          <Key colour="var(--color-board)" label="Kept" />
          <Key colour="var(--color-brass)" label="Cost of goods" />
        </div>
      )}

      <div className="relative" style={{ paddingLeft: AXIS_GUTTER }} aria-labelledby={titleId} role="img">
        {/* Gridlines, behind everything. Inset by the gutter so the scale
            labels have somewhere to sit without being clipped. */}
        <div
          className="absolute top-0 right-0"
          style={{ left: AXIS_GUTTER, height: PLOT_HEIGHT }}
          aria-hidden="true"
        >
          {ticks.map((tick) => {
            const bottom = (tick / ceiling) * PLOT_HEIGHT;
            return (
              <div key={tick} className="absolute right-0 left-0" style={{ bottom }}>
                <span
                  className="tabular absolute right-full -translate-y-1/2 pr-2 text-right text-micro text-ink-faint"
                  style={{ width: AXIS_GUTTER }}
                >
                  {tick === 0 ? '' : formatPKR(tick)}
                </span>
                <div className={tick === 0 ? 'h-px bg-rule-strong' : 'h-px bg-rule'} />
              </div>
            );
          })}
        </div>

        <div
          className="relative flex items-end"
          style={{ height: PLOT_HEIGHT }}
          onMouseLeave={() => setHover(null)}
        >
          {days.map((day, index) => {
            const profit = day.grossProfit ?? 0;
            const cost = Math.max(day.netSales - profit, 0);
            const totalHeight = (day.netSales / ceiling) * PLOT_HEIGHT;
            const costHeight = showProfit ? (cost / ceiling) * PLOT_HEIGHT : 0;
            const profitHeight = Math.max(totalHeight - costHeight - (showProfit ? 2 : 0), 0);
            const dim = hover !== null && hover !== index;

            return (
              <div
                key={day.date}
                className="flex h-full flex-1 cursor-default items-end justify-center"
                onMouseEnter={() => setHover(index)}
              >
                <div
                  className="flex w-full flex-col justify-end transition-opacity duration-100"
                  style={{ maxWidth: MAX_BAR_WIDTH, height: PLOT_HEIGHT, opacity: dim ? 0.45 : 1 }}
                >
                  {showProfit ? (
                    <>
                      {/* Money kept sits on top of what the goods cost, with a
                          2px gap so the two never bleed into one another. */}
                      <div
                        className="rounded-t-[3px]"
                        style={{ height: profitHeight, background: 'var(--color-board)' }}
                      />
                      <div style={{ height: 2 }} />
                      <div style={{ height: costHeight, background: 'var(--color-brass)' }} />
                    </>
                  ) : (
                    <div
                      className="rounded-t-[3px]"
                      style={{ height: totalHeight, background: 'var(--color-board)' }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex">
          {days.map((day, index) => (
            <span key={day.date} className="flex-1 pt-1.5 text-center text-micro text-ink-faint">
              {days.length <= 14 || index % Math.ceil(days.length / 10) === 0
                ? new Date(`${day.date}T00:00:00`).getDate()
                : ''}
            </span>
          ))}
        </div>

        {active && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-44 rounded border border-rule-strong bg-surface px-3 py-2 shadow-lg"
            style={{
              left: `calc(${AXIS_GUTTER}px + ${((hover + 0.5) / days.length) * 100}% - 5.5rem)`,
            }}
          >
            <p className="text-meta font-medium text-ink">{formatDate(active.date)}</p>
            <dl className="mt-1 space-y-0.5 text-micro">
              <TipRow label="Takings" value={formatPKR(active.netSales)} />
              {active.grossProfit !== null && (
                <>
                  <TipRow
                    label="Kept"
                    value={formatPKR(active.grossProfit)}
                    colour="var(--color-board)"
                  />
                  <TipRow
                    label="Cost"
                    value={formatPKR(active.netSales - active.grossProfit)}
                    colour="var(--color-brass)"
                  />
                </>
              )}
              <TipRow label="Bills" value={String(active.billCount)} />
            </dl>
          </div>
        )}
      </div>
    </figure>
  );
}

function Key({ colour, label }: { colour: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: colour }} />
      <span className="text-micro text-ink-soft">{label}</span>
    </span>
  );
}

function TipRow({
  label,
  value,
  colour,
}: {
  label: string;
  value: string;
  colour?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex items-center gap-1.5 text-ink-soft">
        {colour && <span className="size-2 rounded-sm" style={{ background: colour }} />}
        {label}
      </dt>
      <dd className="tabular text-ink">{value}</dd>
    </div>
  );
}

/** Round the top of the scale up to a number a person would have chosen. */
function niceTicks(peak: number): number[] {
  const rough = peak / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ??
    magnitude * 10;

  const ticks: number[] = [];
  for (let value = 0; value <= peak + step * 0.001; value += step) ticks.push(Math.round(value));
  const last = ticks[ticks.length - 1] ?? 0;
  if (last < peak) ticks.push(Math.round(last + step));
  return ticks;
}
