/**
 * In-memory Prometheus-compatible telemetry metrics collector.
 * Faithfully ports src/telemetry.py with ring-buffered latencies,
 * P50/P90/P95/P99 percentiles, and standard export format.
 */

export class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private latencyRing: number[] = [];
  private ringCapacity: number = 2000;

  constructor() {
    this.initDefaults();
  }

  private initDefaults(): void {
    this.counters.set('http_requests_total', 0);
    this.counters.set('rate_limit_exceeded_total', 0);
    this.counters.set('orchestrator_queries_total', 0);
    this.counters.set('cloud_escalations_total', 0);
    this.counters.set('ingested_documents_total', 6);
    this.gauges.set('indexed_documents_total', 6);
    this.gauges.set('bm25_documents_total', 6);
  }

  public incCounter(name: string, value: number = 1, labels?: Record<string, string>): void {
    const key = labels ? `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : name;
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);

    // Also increment base counter if labeled
    if (labels) {
      const base = this.counters.get(name) || 0;
      this.counters.set(name, base + value);
    }
  }

  public setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  public observeDuration(seconds: number): void {
    if (this.latencyRing.length >= this.ringCapacity) {
      this.latencyRing.shift();
    }
    this.latencyRing.push(seconds);
  }

  public getPercentile(p: number): number {
    if (this.latencyRing.length === 0) return 0.0;
    const sorted = [...this.latencyRing].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number((sorted[idx] * 1000).toFixed(2)); // ms
  }

  public getSnapshot(): {
    requestsTotal: number;
    rateLimitsTotal: number;
    orchestratorQueriesTotal: number;
    cloudEscalationsTotal: number;
    indexedDocs: number;
    bm25Docs: number;
    p50_ms: number;
    p90_ms: number;
    p95_ms: number;
    p99_ms: number;
  } {
    return {
      requestsTotal: this.counters.get('http_requests_total') || 0,
      rateLimitsTotal: this.counters.get('rate_limit_exceeded_total') || 0,
      orchestratorQueriesTotal: this.counters.get('orchestrator_queries_total') || 0,
      cloudEscalationsTotal: this.counters.get('cloud_escalations_total') || 0,
      indexedDocs: this.gauges.get('indexed_documents_total') || 0,
      bm25Docs: this.gauges.get('bm25_documents_total') || 0,
      p50_ms: this.getPercentile(50),
      p90_ms: this.getPercentile(90),
      p95_ms: this.getPercentile(95),
      p99_ms: this.getPercentile(99)
    };
  }

  public exportPrometheus(): string {
    const lines: string[] = [
      '# HELP http_requests_total Total number of HTTP requests processed',
      '# TYPE http_requests_total counter',
      `http_requests_total ${this.counters.get('http_requests_total') || 0}`,
      '',
      '# HELP rate_limit_exceeded_total Total number of requests blocked by Token Bucket',
      '# TYPE rate_limit_exceeded_total counter',
      `rate_limit_exceeded_total ${this.counters.get('rate_limit_exceeded_total') || 0}`,
      '',
      '# HELP orchestrator_queries_total Total True Hybrid RAG queries routed',
      '# TYPE orchestrator_queries_total counter',
      `orchestrator_queries_total ${this.counters.get('orchestrator_queries_total') || 0}`,
      '',
      '# HELP cloud_escalations_total Total queries escalated to cloud fallback',
      '# TYPE cloud_escalations_total counter',
      `cloud_escalations_total ${this.counters.get('cloud_escalations_total') || 0}`,
      '',
      '# HELP indexed_documents_total Current number of documents in vector matrix',
      '# TYPE indexed_documents_total gauge',
      `indexed_documents_total ${this.gauges.get('indexed_documents_total') || 0}`,
      '',
      '# HELP bm25_documents_total Current number of documents in BM25 lexical index',
      '# TYPE bm25_documents_total gauge',
      `bm25_documents_total ${this.gauges.get('bm25_documents_total') || 0}`,
      '',
      '# HELP http_request_duration_seconds Latency percentiles in seconds',
      '# TYPE http_request_duration_seconds summary',
      `http_request_duration_seconds{quantile="0.5"} ${(this.getPercentile(50) / 1000).toFixed(6)}`,
      `http_request_duration_seconds{quantile="0.9"} ${(this.getPercentile(90) / 1000).toFixed(6)}`,
      `http_request_duration_seconds{quantile="0.95"} ${(this.getPercentile(95) / 1000).toFixed(6)}`,
      `http_request_duration_seconds{quantile="0.99"} ${(this.getPercentile(99) / 1000).toFixed(6)}`
    ];

    return lines.join('\n');
  }
}

export const globalMetrics = new MetricsCollector();
