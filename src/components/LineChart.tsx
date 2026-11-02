// Responsive SVG line chart: multiple series, "nice" axis ticks (one label style per axis),
// optional log-scale Y, crosshair + tooltip on hover and keyboard focus, end labels when they
// fit without colliding, and per-pixel min/max downsampling for long series.
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./LineChart.css";

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartSeries {
  name: string;
  /** Any CSS colour. Prefer CHART_COLORS (validated categorical palette, theme-aware). */
  color: string;
  points: ChartPoint[];
  dashed?: boolean;
  /** Stroke width in px. Default 2. */
  width?: number;
}

export interface LineChartProps {
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /** Plot height in px (legend excluded). Default 220. */
  height?: number;
  logY?: boolean;
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
  /** Fixed domain bounds (default: fitted to the data). */
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  /** Show the legend. Default: when there are two or more series. */
  legend?: boolean;
  /** Label each line's last value at the right edge (skipped automatically when labels would collide). Default: ≤ 4 series. */
  endLabels?: boolean;
  /** Placeholder when no series has points. */
  emptyText?: ReactNode;
  /**
   * Vertical reference lines (e.g. phase or cycle boundaries) at these x values, with optional
   * short labels at the top. They do not change the fitted domain; labels that would overlap the
   * previous one are left out.
   */
  xMarkers?: ReadonlyArray<{ x: number; label?: string }>;
  className?: string;
  /** Called with the data x nearest to a click on the plot (or Enter while the chart has focus). */
  onPointClick?: (x: number) => void;
}

/**
 * Categorical series colours in fixed order (validated for colour-vision deficiencies against
 * the app's dark and light surfaces). Use in order; don't cycle — past 8 series, fold or facet.
 */
export const CHART_COLORS: readonly string[] = Array.from({ length: 8 }, (_, i) => `var(--cb-chart-${i + 1})`);

// ------------------------------------------------------------------------------- scales

function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

const tidy = (v: number) => Number(v.toPrecision(12));

/** Multiples of `step` inside [min, max]. */
function stepTicks(min: number, max: number, step: number): number[] {
  const ticks: number[] = [];
  const start = Math.ceil(min / step - 1e-9);
  const end = Math.floor(max / step + 1e-9);
  for (let i = start; i <= end && ticks.length < 50; i++) ticks.push(tidy(i * step));
  return ticks;
}

/** Evenly spaced round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count: number): { ticks: number[]; step: number } {
  const step = niceStep(max - min, count);
  return { ticks: stepTicks(min, max, step), step };
}

const LOG_STEPS = [1, 2, 5];

function logTicks(min: number, max: number, maxCount: number): number[] {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const decades = Math.max(1, hi - lo);
  const out: number[] = [];
  if (decades * 3 <= maxCount + 1) {
    for (let e = lo; e <= hi; e++)
      for (const m of LOG_STEPS) {
        const v = tidy(m * Math.pow(10, e));
        if (v >= min * 0.9999 && v <= max * 1.0001) out.push(v);
      }
  } else {
    const every = Math.ceil(decades / Math.max(1, maxCount));
    for (let e = lo; e <= hi; e += every) {
      const v = tidy(Math.pow(10, e));
      if (v >= min * 0.9999 && v <= max * 1.0001) out.push(v);
    }
  }
  if (out.length >= 2) return out;
  return niceTicks(min, max, maxCount).ticks.filter((t) => t > 0);
}

/** "1-2-5" bounds around a positive range (log axis). */
function logBounds(min: number, max: number): [number, number] {
  const down = (v: number) => {
    const e = Math.floor(Math.log10(v));
    const m = v / Math.pow(10, e);
    return tidy((m >= 5 ? 5 : m >= 2 ? 2 : 1) * Math.pow(10, e));
  };
  const up = (v: number) => {
    const e = Math.floor(Math.log10(v));
    const m = v / Math.pow(10, e);
    return tidy((m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * Math.pow(10, e));
  };
  return [down(min), up(max)];
}

function decimalsFor(step: number): number {
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
}

/**
 * Tick formatter with one style per axis: full numbers with separators below 10,000,
 * compact (k / M / G) for the whole axis once it reaches 10,000.
 */
function axisFormatter(ticks: number[], step: number | undefined): (v: number) => string {
  const max = Math.max(0, ...ticks.map(Math.abs));
  const units: Array<[number, string]> = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [div, suffix] of units) {
    if (max >= div * 10 || (div > 1e3 && max >= div)) {
      const d = step ? decimalsFor(step / div) : 1;
      return (v) => (v === 0 ? "0" : (v / div).toFixed(Math.min(d, 2)) + suffix);
    }
  }
  if (step === undefined) return (v) => String(Number(v.toPrecision(3)));
  const d = decimalsFor(step);
  return (v) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Free-standing value (tooltips, end labels): ~4 significant digits, compact when large. */
function valueFormat(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "G";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (v / 1e3).toFixed(1) + "k";
  if (a >= 100) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a === 0) return "0";
  return String(Number(v.toPrecision(4)));
}

/** Per-pixel-column min/max decimation (keeps spikes, preserves x order). */
function decimate(xs: Float64Array, ys: Float64Array): number[] {
  const keep: number[] = [];
  let bucket = NaN;
  let first = -1;
  let minI = -1;
  let maxI = -1;
  let last = -1;
  const flush = () => {
    if (first < 0) return;
    const set = [first, minI, maxI, last].sort((a, b) => a - b);
    for (let k = 0; k < set.length; k++) if (k === 0 || set[k] !== set[k - 1]) keep.push(set[k]);
  };
  for (let i = 0; i < xs.length; i++) {
    const b = Math.floor(xs[i]);
    if (b !== bucket) {
      flush();
      bucket = b;
      first = minI = maxI = last = i;
    } else {
      last = i;
      if (ys[i] < ys[minI]) minI = i;
      if (ys[i] > ys[maxI]) maxI = i;
    }
  }
  flush();
  return keep;
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) >= 1 ? Math.floor(w) : prev));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

interface Prepared {
  name: string;
  color: string;
  dashed: boolean;
  width: number;
  /** Finite points sorted by x. */
  points: ChartPoint[];
}

/** Index of the point with x nearest to `x` (points sorted by x, non-empty). */
function nearestIndex(points: ChartPoint[], x: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].x - x) <= Math.abs(points[hi].x - x) ? lo : hi;
}

export function LineChart({
  series,
  xLabel,
  yLabel,
  height = 220,
  logY = false,
  formatX,
  formatY,
  xMin,
  xMax,
  yMin,
  yMax,
  legend,
  endLabels,
  emptyText = "No data yet",
  xMarkers,
  className,
  onPointClick,
}: LineChartProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  /** Set by pointerdown so the focus that follows a click does not jump to the last point. */
  const pointerFocus = useRef(false);
  const width = useElementWidth(boxRef, 560);
  const clipId = "cbclip" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  /** Hovered/focused x in data units. */
  const [activeX, setActiveX] = useState<number | null>(null);

  const prepared = useMemo<Prepared[]>(
    () =>
      series.map((s) => {
        const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!logY || p.y > 0));
        let sorted = true;
        for (let i = 1; i < pts.length; i++)
          if (pts[i].x < pts[i - 1].x) {
            sorted = false;
            break;
          }
        return {
          name: s.name,
          color: s.color,
          dashed: !!s.dashed,
          width: s.width ?? 2,
          points: sorted ? pts : pts.slice().sort((a, b) => a.x - b.x),
        };
      }),
    [series, logY],
  );
  const withData = useMemo(() => prepared.filter((s) => s.points.length > 0), [prepared]);
  const hasData = withData.length > 0;

  // ---------------------------------------------------------------------------- domain
  const dom = useMemo(() => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of prepared)
      for (const p of s.points) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
    if (!Number.isFinite(x0)) {
      x0 = 0;
      x1 = 1;
    }
    if (!Number.isFinite(y0)) {
      y0 = logY ? 1 : 0;
      y1 = logY ? 10 : 1;
    }
    if (xMin !== undefined) x0 = xMin;
    if (xMax !== undefined) x1 = xMax;
    if (yMin !== undefined && (!logY || yMin > 0)) y0 = yMin;
    if (yMax !== undefined && (!logY || yMax > 0)) y1 = yMax;
    if (x1 <= x0) {
      x0 -= 0.5;
      x1 += 0.5;
    }
    if (y1 <= y0) {
      if (logY) {
        y0 /= 2;
        y1 *= 2;
      } else {
        const d = Math.abs(y0) * 0.1 || 1;
        y0 -= d;
        y1 += d;
      }
    }
    return { x0, x1, y0, y1 };
  }, [prepared, logY, xMin, xMax, yMin, yMax]);

  const yTickCount = Math.max(2, Math.round(height / 48));
  const yAxis = useMemo(() => {
    if (logY) {
      const [lo, hi] = yMin !== undefined && yMax !== undefined ? [dom.y0, dom.y1] : logBounds(dom.y0, dom.y1);
      return { lo, hi, ticks: logTicks(lo, hi, yTickCount), step: undefined as number | undefined };
    }
    // Extend the fitted range outwards to whole ticks so the plot starts and ends on a gridline.
    const step = niceStep(dom.y1 - dom.y0, yTickCount);
    const lo = yMin !== undefined ? dom.y0 : tidy(Math.floor(dom.y0 / step + 1e-9) * step);
    const hi = yMax !== undefined ? dom.y1 : tidy(Math.ceil(dom.y1 / step - 1e-9) * step);
    return { lo, hi: hi > lo ? hi : lo + step, ticks: stepTicks(lo, hi, step), step };
  }, [dom, logY, yTickCount, yMin, yMax]);

  const tickY = useMemo(() => formatY ?? axisFormatter(yAxis.ticks, yAxis.step), [formatY, yAxis]);
  const fmtValueY = formatY ?? valueFormat;
  const fmtValueX = formatX ?? valueFormat;
  const yLabels = yAxis.ticks.map(tickY);

  const showEndLabels = (endLabels ?? withData.length <= 4) && hasData;
  const endTexts = showEndLabels ? withData.map((s) => fmtValueY(s.points[s.points.length - 1].y)) : [];
  const labelWidth = Math.max(18, ...yLabels.map((l) => l.length * 6.6));
  const padLeft = Math.ceil(labelWidth + 12 + (yLabel ? 16 : 0));
  const padRight = showEndLabels ? Math.ceil(Math.max(...endTexts.map((t) => t.length * 6.8)) + 18) : 14;
  const padTop = 10;
  const padBottom = 24 + (xLabel ? 18 : 0);
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = Math.max(10, height - padTop - padBottom);

  const xTicksInfo = useMemo(() => niceTicks(dom.x0, dom.x1, Math.max(2, Math.floor(plotW / 90))), [dom, plotW]);
  const tickX = useMemo(() => formatX ?? axisFormatter(xTicksInfo.ticks, xTicksInfo.step), [formatX, xTicksInfo]);

  const sx = (x: number) => padLeft + ((x - dom.x0) / (dom.x1 - dom.x0)) * plotW;
  const ly0 = logY ? Math.log10(yAxis.lo) : yAxis.lo;
  const ly1 = logY ? Math.log10(yAxis.hi) : yAxis.hi;
  const sy = (y: number) => {
    const v = logY ? Math.log10(y) : y;
    return padTop + (1 - (v - ly0) / (ly1 - ly0 || 1)) * plotH;
  };

  // ---------------------------------------------------------------------------- paths
  const paths = useMemo(
    () =>
      prepared.map((s) => {
        const n = s.points.length;
        if (n === 0) return "";
        const xs = new Float64Array(n);
        const ys = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          xs[i] = sx(s.points[i].x);
          ys[i] = sy(s.points[i].y);
        }
        const idx = n > plotW * 2 ? decimate(xs, ys) : null;
        let d = "";
        const count = idx ? idx.length : n;
        for (let k = 0; k < count; k++) {
          const i = idx ? idx[k] : k;
          d += (k === 0 ? "M" : "L") + xs[i].toFixed(1) + " " + ys[i].toFixed(1);
        }
        return d;
      }),
    // sx/sy are derived from exactly these values.
    [prepared, dom, yAxis, plotW, plotH, padLeft, logY],
  );

  // End labels: dropped entirely when any two would collide (the legend + tooltip carry identity).
  let endLabelItems: Array<{ name: string; y: number; text: string }> = [];
  if (showEndLabels) {
    endLabelItems = withData.map((s, i) => ({ name: s.name, y: sy(s.points[s.points.length - 1].y), text: endTexts[i] }));
    const ys = endLabelItems.map((it) => it.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < 13) endLabelItems = [];
  }

  // ---------------------------------------------------------------------------- hover / focus
  const hover = useMemo(() => {
    if (activeX === null || !hasData) return null;
    // Snap to the data x nearest (in pixels) to the pointer across all series.
    let snap = withData[0].points[0].x;
    let best = Infinity;
    for (const s of withData) {
      const p = s.points[nearestIndex(s.points, activeX)];
      const d = Math.abs(p.x - activeX);
      if (d < best) {
        best = d;
        snap = p.x;
      }
    }
    // One readout lists every series at that x (its nearest point).
    const rows = withData.map((s) => ({ name: s.name, color: s.color, point: s.points[nearestIndex(s.points, snap)] }));
    return { x: snap, rows };
  }, [activeX, withData, hasData]);

  /** Data x under a client X coordinate, or null outside the plot area. */
  const xAtClient = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const px = clientX - svg.getBoundingClientRect().left;
    if (px < padLeft || px > padLeft + plotW) return null;
    return dom.x0 + ((px - padLeft) / plotW) * (dom.x1 - dom.x0);
  };

  /** Keyboard: step through the x positions of the densest series. */
  const stepFocus = (dir: -1 | 1 | "first" | "last") => {
    if (!hasData) return;
    const ref = withData.reduce((a, b) => (b.points.length > a.points.length ? b : a));
    const pts = ref.points;
    let i: number;
    if (dir === "first") i = 0;
    else if (dir === "last" || activeX === null) i = pts.length - 1;
    else i = Math.max(0, Math.min(pts.length - 1, nearestIndex(pts, activeX) + dir));
    setActiveX(pts[i].x);
  };

  const showLegend = legend ?? series.length > 1;
  const hoverPx = hover ? sx(hover.x) : 0;
  const tooltipLeft = hover ? (hoverPx + 14 + 190 > width ? Math.max(4, hoverPx - 14 - 190) : hoverPx + 14) : 0;
  const summary = withData
    .map((s) => {
      const ys = s.points.map((p) => p.y);
      return `${s.name}: ${s.points.length} points, last ${fmtValueY(ys[ys.length - 1])}, min ${fmtValueY(Math.min(...ys))}, max ${fmtValueY(Math.max(...ys))}`;
    })
    .join("; ");

  return (
    <div className={"cb-chart" + (className ? " " + className : "")}>
      {showLegend && (
        <div className="cb-chart-legend">
          {series.map((s) => (
            <span key={s.name} className="cb-chart-legend-item">
              <svg width="18" height="8" aria-hidden="true">
                <line x1="1" x2="17" y1="4" y2="4" strokeWidth="2" strokeLinecap="round" strokeDasharray={s.dashed ? "4 3" : undefined} style={{ stroke: s.color }} />
              </svg>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div
        ref={boxRef}
        className="cb-chart-box"
        style={{ height }}
        tabIndex={hasData ? 0 : undefined}
        aria-label={`${yLabel ?? "Chart"}${xLabel ? ` by ${xLabel}` : ""}. ${summary || "No data."} Use the arrow keys to read values.`}
        onKeyDown={(e) => {
          const map: Record<string, -1 | 1 | "first" | "last"> = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
          if (e.key in map) {
            e.preventDefault();
            stepFocus(map[e.key]);
          } else if (e.key === "Escape") setActiveX(null);
          else if (e.key === "Enter" && onPointClick && hover) {
            e.preventDefault();
            onPointClick(hover.x);
          }
        }}
        onPointerDown={(e) => {
          // A click (or tap) focuses the box: show the point under the pointer, not the last one.
          // pointerdown comes before focus, and before any pending pointermove re-render.
          pointerFocus.current = true;
          const x = xAtClient(e.clientX);
          if (x !== null) setActiveX(x);
        }}
        onFocus={(e) => {
          const fromPointer = pointerFocus.current;
          pointerFocus.current = false;
          // Keyboard focus starts the readout at the latest point.
          if (!fromPointer && e.target === e.currentTarget && activeX === null) stepFocus("last");
        }}
        onBlur={() => {
          pointerFocus.current = false;
          setActiveX(null);
        }}
      >
        <svg ref={svgRef} width={width} height={height} className="cb-chart-svg" aria-hidden="true">
          <defs>
            <clipPath id={clipId}>
              <rect x={padLeft} y={padTop - 4} width={plotW} height={plotH + 8} />
            </clipPath>
          </defs>
          <g className="cb-chart-grid">
            {yAxis.ticks.map((t, i) => {
              const y = sy(t);
              if (y < padTop - 0.5 || y > padTop + plotH + 0.5) return null;
              return (
                <g key={`y${i}`}>
                  <line x1={padLeft} x2={padLeft + plotW} y1={Math.round(y) + 0.5} y2={Math.round(y) + 0.5} />
                  {hasData && (
                    <text x={padLeft - 8} y={y} dy="0.32em" textAnchor="end">
                      {yLabels[i]}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          <g className="cb-chart-axis">
            <line x1={padLeft} x2={padLeft + plotW} y1={padTop + plotH + 0.5} y2={padTop + plotH + 0.5} />
            {xTicksInfo.ticks.map((t, i) => {
              const x = sx(t);
              if (!hasData || x < padLeft - 0.5 || x > padLeft + plotW + 0.5) return null;
              return (
                <text key={`x${i}`} x={x} y={padTop + plotH + 16} textAnchor="middle">
                  {tickX(t)}
                </text>
              );
            })}
          </g>
          {yLabel && (
            <text className="cb-chart-title" transform={`translate(12 ${padTop + plotH / 2}) rotate(-90)`} textAnchor="middle">
              {yLabel}
            </text>
          )}
          {xLabel && (
            <text className="cb-chart-title" x={padLeft + plotW / 2} y={height - 6} textAnchor="middle">
              {xLabel}
            </text>
          )}
          {hasData && xMarkers && xMarkers.length > 0 && (
            <g className="cb-chart-markers">
              {(() => {
                let lastLabelX = -Infinity;
                return xMarkers.map((m, i) => {
                  const x = Math.round(sx(m.x)) + 0.5;
                  if (!Number.isFinite(x) || x < padLeft || x > padLeft + plotW) return null;
                  const showLabel = !!m.label && x - lastLabelX >= 56 && x + 4 + m.label.length * 6 <= padLeft + plotW + padRight;
                  if (showLabel) lastLabelX = x;
                  return (
                    <g key={`mk${i}`}>
                      <line x1={x} x2={x} y1={padTop} y2={padTop + plotH} />
                      {showLabel && (
                        <text x={x + 4} y={padTop + 9}>
                          {m.label}
                        </text>
                      )}
                    </g>
                  );
                });
              })()}
            </g>
          )}
          <g clipPath={`url(#${clipId})`}>
            {prepared.map((s, i) =>
              s.points.length > 1 ? (
                <path
                  key={i}
                  d={paths[i]}
                  fill="none"
                  strokeWidth={s.width}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={s.dashed ? "6 5" : undefined}
                  style={{ stroke: s.color }}
                />
              ) : null,
            )}
          </g>
          {hover && <line className="cb-chart-crosshair" x1={hoverPx} x2={hoverPx} y1={padTop} y2={padTop + plotH} />}
          {/* End markers (and single points), ringed in the surface colour. */}
          {withData.map((s) => {
            const p = s.points[s.points.length - 1];
            return <circle key={`end-${s.name}`} className="cb-chart-dot" cx={sx(p.x)} cy={sy(p.y)} r={4} style={{ fill: s.color }} />;
          })}
          {hover?.rows.map((r) => (
            <circle key={`hv-${r.name}`} className="cb-chart-dot" cx={sx(r.point.x)} cy={sy(r.point.y)} r={4.5} style={{ fill: r.color }} />
          ))}
          {endLabelItems.map((it) => (
            <text key={`lbl-${it.name}`} className="cb-chart-endlabel" x={padLeft + plotW + 9} y={it.y} dy="0.32em">
              {it.text}
            </text>
          ))}
          <rect
            className="cb-chart-overlay"
            x={padLeft}
            y={0}
            width={plotW}
            height={padTop + plotH}
            onPointerMove={(e) => {
              const x = xAtClient(e.clientX);
              if (x !== null) setActiveX(x);
            }}
            onPointerLeave={() => setActiveX(null)}
            onClick={
              onPointClick && hasData
                ? (e) => {
                    const svg = e.currentTarget.ownerSVGElement;
                    if (!svg) return;
                    const x = dom.x0 + ((e.clientX - svg.getBoundingClientRect().left - padLeft) / plotW) * (dom.x1 - dom.x0);
                    // Snap to the nearest data x of any series (as the hover readout does).
                    let snap = withData[0].points[0].x;
                    for (const s of withData) {
                      const p = s.points[nearestIndex(s.points, x)];
                      if (Math.abs(p.x - x) < Math.abs(snap - x)) snap = p.x;
                    }
                    onPointClick(snap);
                  }
                : undefined
            }
            style={onPointClick && hasData ? { cursor: "pointer" } : undefined}
          />
        </svg>
        {!hasData && <div className="cb-chart-empty">{emptyText}</div>}
        {hover && (
          <div className="cb-chart-tooltip" style={{ left: tooltipLeft, top: padTop + 2 }} role="status">
            <div className="cb-chart-tooltip-x">
              {xLabel ? `${xLabel} ` : ""}
              {fmtValueX(hover.x)}
            </div>
            {hover.rows.map((r) => (
              <div key={r.name} className="cb-chart-tooltip-row">
                <svg width="12" height="8" aria-hidden="true">
                  <line x1="1" x2="11" y1="4" y2="4" strokeWidth="2" strokeLinecap="round" style={{ stroke: r.color }} />
                </svg>
                <span className="value">{fmtValueY(r.point.y)}</span>
                <span className="name">
                  {r.name}
                  {r.point.x !== hover.x && <span className="at"> · at {fmtValueX(r.point.x)}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
