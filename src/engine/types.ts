export type PrivacyMode = 'hybrid' | 'local_only';

export type RouteDecision =
  | 'RESOLVE_LOCAL_HIGH'
  | 'RESOLVE_LOCAL_MED'
  | 'RESOLVE_LOCAL_ZERO_SHOT'
  | 'LOCAL_ABSTENTION'
  | 'ESCALATE_TO_CLOUD'
  | 'ESCALATE_TO_CLOUD_FALLBACK';

export type DocumentType = 'document' | 'qa_cache';

export interface DocumentMetadata {
  source?: string;
  framework?: string;
  tags?: string[];
  system_prompt_hash?: string;
  expires_at_timestamp?: number;
  query?: string;
  [key: string]: any;
}

export interface StoredDocument {
  id: string;
  text: string;
  type: DocumentType;
  created_at: string;
  metadata: DocumentMetadata;
  vector?: number[];
}

export interface HybridMetrics {
  rrf_score: number;
  dense_score: number;
  bm25_score: number;
  effective_score: number;
}

export interface MatchResult {
  route: RouteDecision;
  doc: (StoredDocument & { retrieval_mode?: string; hybrid_metrics?: HybridMetrics }) | null;
  score: number;
}

export interface RankCandidatesResult {
  dense: string[];
  sparse: string[];
  hybrid: string[];
}

export interface QueryRequest {
  query: string;
  system_prompt?: string;
  allow_cloud_fallback?: boolean;
  force_cloud?: boolean;
  audit_assert?: boolean;
  stream?: boolean;
}

export interface TelemetryInfo {
  total_latency_ms: number;
  escalated_to_cloud: boolean;
  local_available: boolean;
  storage_warning: string | null;
}

export interface AssertAuditResult {
  passed: boolean;
  technical_score: number;
  overall_score: number;
  hallucination_risk: 'low' | 'medium' | 'high';
  epistemic_certainty: 'Cierto' | 'Probable' | 'Adivinando';
  critique: string;
  checked_controls: string[];
}

export interface OrchestratorResponse {
  request_id: string;
  query: string;
  route_taken: RouteDecision;
  source: string;
  similarity_score: number;
  answer: string;
  second_brain_doc_id: string | null;
  telemetry: TelemetryInfo;
  assert_audit: AssertAuditResult | null;
  hybrid_metrics?: HybridMetrics;
}

export interface SecondBrainNote {
  id: string;
  query: string;
  answer: string;
  source: string;
  latency_ms: number;
  similarity_score: number;
  route: string;
  created_at: string;
  markdown: string;
}

export interface BenchmarkQuery {
  id: string;
  query: string;
  expected_doc_id: string;
  domain: string;
  type: string;
}

export interface BenchmarkResultItem {
  id: string;
  query: string;
  expected_doc_id: string;
  dense_rank: number | null;
  sparse_rank: number | null;
  hybrid_rank: number | null;
  dense_hit1: boolean;
  dense_hit3: boolean;
  sparse_hit1: boolean;
  sparse_hit3: boolean;
  hybrid_hit1: boolean;
  hybrid_hit3: boolean;
  dense_rr: number;
  sparse_rr: number;
  hybrid_rr: number;
}

export interface BenchmarkSummary {
  strategy: 'dense' | 'sparse' | 'hybrid';
  name: string;
  hit1: number;
  hit3: number;
  mrr: number;
  p50_latency_ms: number;
}
