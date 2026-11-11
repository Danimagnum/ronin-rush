/**
 * Prometheus text exposition (format 0.0.4), written by hand to avoid a dependency for a few
 * dozen lines. Families are computed at scrape time from the services' own counters.
 */
export type Labels = Record<string, string | number>;

export interface MetricFamily {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  samples: Array<{ labels?: Labels; value: number; suffix?: '_bucket' | '_sum' | '_count' }>;
}

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function labelText(labels?: Labels): string {
  if (!labels) return '';
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escape(String(v))}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function num(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

export function renderPrometheus(families: MetricFamily[]): string {
  const out: string[] = [];
  for (const f of families) {
    out.push(`# HELP ${f.name} ${f.help.replace(/\n/g, ' ')}`);
    out.push(`# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) out.push(`${f.name}${s.suffix ?? ''}${labelText(s.labels)} ${num(s.value)}`);
  }
  return `${out.join('\n')}\n`;
}

export const HTTP_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

interface Series {
  labels: Labels;
  count: number;
  sum: number;
  buckets: number[]; // cumulative counts per HTTP_BUCKETS_SECONDS entry
}

/**
 * HTTP request metrics required by platform-infra (http_requests_total and
 * http_request_duration_seconds), plus a 60-second window for the health report.
 */
export class HttpMetrics {
  private readonly series = new Map<string, Series>();
  private readonly window: Array<{ at: number; ms: number; error: boolean }> = [];
  static readonly WINDOW_MS = 60_000;

  record(method: string, route: string, status: number, ms: number, now = Date.now()): void {
    const labels = { method, route, status_code: status };
    const key = `${method} ${route} ${status}`;
    let s = this.series.get(key);
    if (!s) {
      s = { labels, count: 0, sum: 0, buckets: HTTP_BUCKETS_SECONDS.map(() => 0) };
      this.series.set(key, s);
    }
    const seconds = ms / 1000;
    s.count++;
    s.sum += seconds;
    HTTP_BUCKETS_SECONDS.forEach((le, i) => {
      if (seconds <= le) s.buckets[i]!++;
    });
    this.window.push({ at: now, ms, error: status >= 500 });
    this.trim(now);
  }

  /** p95 latency (ms) and 5xx fraction over the last 60 s; zeros for an empty window. */
  windowStats(now = Date.now()): { latencyP95: number; errorRate: number; requests: number } {
    this.trim(now);
    if (!this.window.length) return { latencyP95: 0, errorRate: 0, requests: 0 };
    const sorted = this.window.map((w) => w.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    const errors = this.window.filter((w) => w.error).length;
    return { latencyP95: Math.round(p95 * 10) / 10, errorRate: Math.round((errors / this.window.length) * 1000) / 1000, requests: this.window.length };
  }

  families(): MetricFamily[] {
    const all = [...this.series.values()];
    return [
      {
        name: 'http_requests_total',
        help: 'HTTP requests handled, by method, route template and status code.',
        type: 'counter',
        samples: all.map((s) => ({ labels: s.labels, value: s.count })),
      },
      {
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration in seconds.',
        type: 'histogram',
        samples: all.flatMap((s) => [
          ...HTTP_BUCKETS_SECONDS.map((le, i) => ({ labels: { ...s.labels, le }, value: s.buckets[i]!, suffix: '_bucket' as const })),
          { labels: { ...s.labels, le: '+Inf' }, value: s.count, suffix: '_bucket' as const },
          { labels: s.labels, value: s.sum, suffix: '_sum' as const },
          { labels: s.labels, value: s.count, suffix: '_count' as const },
        ]),
      },
    ];
  }

  private trim(now: number): void {
    const cutoff = now - HttpMetrics.WINDOW_MS;
    while (this.window.length && (this.window[0]!.at < cutoff || this.window.length > 20_000)) this.window.shift();
  }
}
