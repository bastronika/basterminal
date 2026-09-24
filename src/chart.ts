// Tiny SVG chart helpers for the resource monitor: a time-series line chart
// with crosshair + tooltip, and a meter. Specs follow the app's dataviz rules:
// 2px lines, 10% area wash, end dot with a 2px surface ring, hairline grid,
// text in ink tokens (never the series colour), legend for >= 2 series.
import { h } from "./ui";

const SVG = "http://www.w3.org/2000/svg";

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export interface Series {
  label: string;
  /** CSS colour (a var() token). */
  color: string;
  values: (number | null)[];
}

export interface LineChartOpts {
  width: number;
  height: number;
  /** Fixed y maximum (e.g. 100 for %); otherwise derived from the data. */
  max?: number;
  format: (v: number) => string;
  /** Label for a point index, e.g. "-12 dtk". */
  xLabel: (i: number) => string;
}

/** Rounds up to 1/2/5 × 10^n so the top gridline gets a clean label. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

export function lineChart(series: Series[], o: LineChartOpts): HTMLElement {
  const n = Math.max(...series.map((x) => x.values.length), 2);
  const all = series.flatMap((x) => x.values.filter((v): v is number => v !== null));
  const max = o.max ?? niceMax(Math.max(0, ...all));
  const padL = 2, padR = 10, padT = 8, padB = 4;
  const w = Math.max(120, o.width), hgt = o.height;
  const x = (i: number) => padL + (i / (n - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - Math.min(v, max) / max) * (hgt - padT - padB);

  const svg = s("svg", { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: "chart-svg", role: "img" });
  // Hairline grid: baseline + top + middle.
  for (const f of [0, 0.5, 1]) {
    svg.append(s("line", { x1: padL, x2: w - padR, y1: y(max * f), y2: y(max * f), class: f === 0 ? "chart-base" : "chart-grid" }));
  }
  for (const ser of series) {
    const pts = ser.values.map((v, i) => (v === null ? null : [x(i + n - ser.values.length), y(v)] as const));
    const segs: (readonly [number, number])[][] = [];
    let cur: (readonly [number, number])[] = [];
    for (const p of pts) {
      if (p) cur.push(p);
      else if (cur.length) (segs.push(cur), (cur = []));
    }
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      const d = seg.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
      if (series.length === 1 && seg.length > 1) {
        const area = `${d}L${seg[seg.length - 1][0].toFixed(1)},${y(0)}L${seg[0][0].toFixed(1)},${y(0)}Z`;
        svg.append(s("path", { d: area, fill: ser.color, "fill-opacity": 0.1, stroke: "none" }));
      }
      svg.append(s("path", { d, fill: "none", stroke: ser.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    const last = [...pts].reverse().find((p) => p);
    if (last) svg.append(s("circle", { cx: last[0], cy: last[1], r: 4, fill: ser.color, class: "chart-dot" }));
  }

  // Hover layer: crosshair snaps to the nearest sample; one tooltip lists every series.
  const cross = s("line", { y1: padT, y2: hgt - padB, class: "chart-cross", visibility: "hidden" });
  svg.append(cross);
  const tip = h("div", { class: "chart-tip", hidden: true });
  const wrap = h("div", { class: "chart-wrap", tabindex: 0 }, svg as unknown as Node, tip);
  const show = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    const i = Math.round(((clientX - r.left - padL) / (w - padL - padR)) * (n - 1));
    const idx = Math.max(0, Math.min(n - 1, i));
    cross.setAttribute("x1", String(x(idx)));
    cross.setAttribute("x2", String(x(idx)));
    cross.setAttribute("visibility", "visible");
    tip.replaceChildren(
      h("div", { class: "chart-tip-x" }, o.xLabel(idx)),
      ...series.map((ser) => {
        const v = ser.values[idx - (n - ser.values.length)];
        return h(
          "div",
          { class: "chart-tip-row" },
          h("span", { class: "line-key", style: `background:${ser.color}` }),
          h("strong", {}, v === null || v === undefined ? "–" : o.format(v)),
          series.length > 1 ? h("span", { class: "muted" }, ser.label) : null,
        );
      }),
    );
    tip.hidden = false;
    const left = Math.min(Math.max(0, x(idx) - 50), w - 110);
    tip.style.left = `${left}px`;
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  wrap.addEventListener("pointermove", (e) => show(e.clientX));
  wrap.addEventListener("pointerdown", (e) => show(e.clientX));
  wrap.addEventListener("pointerleave", hide);
  wrap.addEventListener("focus", () => show(svg.getBoundingClientRect().right - padR));
  wrap.addEventListener("blur", hide);
  return wrap;
}

/** Legend with line keys (mirrors the line marks); used for >= 2 series. */
export function legend(series: Series[], values: string[]) {
  return h(
    "div",
    { class: "chart-legend" },
    ...series.map((ser, i) =>
      h("span", {}, h("span", { class: "line-key", style: `background:${ser.color}` }), `${ser.label} `, h("strong", {}, values[i] ?? "")),
    ),
  );
}

export type Severity = "ok" | "warning" | "critical";

export function severity(pct: number): Severity {
  return pct >= 95 ? "critical" : pct >= 85 ? "warning" : "ok";
}

/** Meter: fill carries severity; the track is a darker step of the same ramp.
 *  High values also get an icon + word so colour never carries meaning alone. */
export function meter(pct: number, label: string) {
  const sev = severity(pct);
  const p = Math.max(0, Math.min(100, pct));
  return h(
    "div",
    { class: `meter ${sev}`, role: "meter", "aria-valuenow": Math.round(p), "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": label },
    h("div", { class: "meter-fill", style: `width:${p.toFixed(1)}%` }),
  );
}

export function severityTag(pct: number) {
  const sev = severity(pct);
  if (sev === "ok") return null;
  return h("span", { class: `sev-tag ${sev}` }, sev === "critical" ? "⛔ kritis" : "⚠ tinggi");
}
