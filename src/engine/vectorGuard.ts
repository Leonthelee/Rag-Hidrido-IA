import { StoredDocument, MatchResult, RankCandidatesResult, DocumentType } from './types';
import { BM25Index, reciprocalRankFusion } from './bm25';
import { cosineSimilarity, generateEmbedding } from './embeddings';
import { getInitialCorpusWithVectors } from './cyberstrikeCorpus';

export const DEFAULT_HIGH_THRESHOLD = 0.85;
export const DEFAULT_MIN_THRESHOLD = 0.65;

const STORAGE_KEY = 'open_hybrid_rag_vector_guard_v1';

export class VectorGuard {
  public highThreshold: number;
  public minThreshold: number;
  public expectedDim: number | null = null;
  public docIds: string[] = [];
  public vectors: Map<string, number[]> = new Map();
  public documents: Map<string, StoredDocument> = new Map();
  public bm25: BM25Index = new BM25Index();

  constructor(
    highThreshold: number = DEFAULT_HIGH_THRESHOLD,
    minThreshold: number = DEFAULT_MIN_THRESHOLD
  ) {
    this.highThreshold = highThreshold;
    this.minThreshold = minThreshold;
    this.loadFromStorage();
  }

  /**
   * Deterministic hash of system prompt to isolate cache between different personalities/contexts.
   */
  public static computePromptHash(systemPrompt?: string): string {
    const normalized = (systemPrompt || '').trim().toLowerCase();
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Adds or updates a document in O(1) amortized time.
   */
  public addDocument(
    docId: string,
    text: string,
    vector?: number[],
    docType: DocumentType = 'document',
    systemPrompt?: string,
    ttlSeconds?: number,
    metadata?: Record<string, any>
  ): boolean {
    const vec = vector && vector.length > 0 ? vector : generateEmbedding(text);

    if (this.expectedDim === null) {
      this.expectedDim = vec.length;
    } else if (vec.length !== this.expectedDim) {
      throw new Error(
        `Incompatible dimension: expected ${this.expectedDim}, got ${vec.length}`
      );
    }

    const docMeta: Record<string, any> = { ...(metadata || {}) };
    if (systemPrompt) {
      docMeta.system_prompt_hash = VectorGuard.computePromptHash(systemPrompt);
    }
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      docMeta.expires_at_timestamp = Date.now() / 1000 + ttlSeconds;
    }

    if (!this.documents.has(docId)) {
      this.docIds.push(docId);
    }

    const doc: StoredDocument = {
      id: docId,
      text,
      type: docType,
      created_at: new Date().toISOString(),
      metadata: docMeta,
      vector: vec
    };

    this.documents.set(docId, doc);
    this.vectors.set(docId, vec);
    this.bm25.addDocument(docId, text);

    this.saveToStorage();
    return true;
  }

  /**
   * Batch ingest documents.
   */
  public addDocumentsBatch(
    batch: Array<{
      doc_id?: string;
      text: string;
      vector?: number[];
      doc_type?: DocumentType;
      system_prompt?: string;
      ttl_seconds?: number;
      metadata?: Record<string, any>;
    }>
  ): number {
    let added = 0;
    for (const item of batch) {
      try {
        const id = item.doc_id || `DOC-${Math.random().toString(36).substring(2, 9)}`;
        this.addDocument(
          id,
          item.text,
          item.vector,
          item.doc_type || 'document',
          item.system_prompt,
          item.ttl_seconds,
          item.metadata
        );
        added++;
      } catch (err) {
        console.warn('Batch ingest error:', err);
      }
    }
    return added;
  }

  /**
   * Deletes a document from vector memory, BM25 index, and metadata store.
   */
  public deleteDocument(docId: string): boolean {
    if (!this.documents.has(docId)) {
      return false;
    }

    this.documents.delete(docId);
    this.vectors.delete(docId);
    const idx = this.docIds.indexOf(docId);
    if (idx !== -1) {
      this.docIds.splice(idx, 1);
    }
    this.bm25.deleteDocument(docId);

    if (this.docIds.length === 0) {
      this.expectedDim = null;
    }

    this.saveToStorage();
    return true;
  }

  /**
   * True Hybrid RAG matching:
   * 1. Dense retrieval (cosine similarity)
   * 2. Sparse retrieval (Okapi BM25 for exact technical tokens)
   * 3. Reciprocal Rank Fusion (RRF k=60)
   * 4. Route decision + lexical boost + system prompt hash check
   */
  public hybridMatch(
    queryText: string,
    queryVector?: number[],
    systemPrompt?: string,
    alpha: number = 0.5
  ): MatchResult {
    if (this.docIds.length === 0) {
      return { route: 'ESCALATE_TO_CLOUD', doc: null, score: 0.0 };
    }

    const qVec = queryVector || generateEmbedding(queryText);

    // 1. Dense scoring
    const denseScores = new Map<string, number>();
    for (const id of this.docIds) {
      const v = this.vectors.get(id);
      if (v) {
        denseScores.set(id, cosineSimilarity(v, qVec));
      }
    }

    const denseRanks = Array.from(denseScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    // 2. Sparse Okapi BM25 scoring
    const bm25Scores = this.bm25.score(queryText);
    const sparseRanks = Array.from(bm25Scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    if (denseRanks.length === 0 && sparseRanks.length === 0) {
      return { route: 'ESCALATE_TO_CLOUD', doc: null, score: 0.0 };
    }

    // 3. Reciprocal Rank Fusion
    const fused = reciprocalRankFusion(denseRanks, sparseRanks, 60, alpha, 1.0 - alpha);
    if (fused.length === 0) {
      return { route: 'ESCALATE_TO_CLOUD', doc: null, score: 0.0 };
    }

    const [bestDocId, rrfScore] = fused[0];
    const bestDoc = this.documents.get(bestDocId);
    if (!bestDoc) {
      return { route: 'ESCALATE_TO_CLOUD', doc: null, score: 0.0 };
    }

    // Check TTL expiration
    const expTs = bestDoc.metadata?.expires_at_timestamp;
    if (expTs && Date.now() / 1000 > expTs) {
      return { route: 'ESCALATE_TO_CLOUD', doc: null, score: 0.0 };
    }

    const bestDenseScore = denseScores.get(bestDocId) || 0.0;
    const bestBm25Score = bm25Scores.get(bestDocId) || 0.0;

    // 4. Effective score calculation with lexical boost
    let effectiveScore = bestDenseScore;
    if (bestBm25Score > 0) {
      const lexicalBoost = Math.min(0.10, (bestBm25Score / (bestBm25Score + 1.5)) * 0.10);
      effectiveScore = Math.min(1.0, bestDenseScore + lexicalBoost);
    }

    const hybridMetrics = {
      rrf_score: Number(rrfScore.toFixed(6)),
      dense_score: Number(bestDenseScore.toFixed(4)),
      bm25_score: Number(bestBm25Score.toFixed(4)),
      effective_score: Number(effectiveScore.toFixed(4))
    };

    const docResult = {
      ...bestDoc,
      retrieval_mode: 'hybrid',
      hybrid_metrics: hybridMetrics
    };

    // 5. Routing threshold decision
    if (effectiveScore >= this.highThreshold) {
      if (bestDoc.type === 'qa_cache') {
        const cachedHash = bestDoc.metadata?.system_prompt_hash;
        if (cachedHash && systemPrompt) {
          const currentHash = VectorGuard.computePromptHash(systemPrompt);
          if (cachedHash !== currentHash) {
            return { route: 'RESOLVE_LOCAL_MED', doc: docResult, score: effectiveScore };
          }
        }
        return { route: 'RESOLVE_LOCAL_HIGH', doc: docResult, score: effectiveScore };
      } else {
        return { route: 'RESOLVE_LOCAL_MED', doc: docResult, score: effectiveScore };
      }
    } else if (effectiveScore >= this.minThreshold) {
      return { route: 'RESOLVE_LOCAL_MED', doc: docResult, score: effectiveScore };
    } else {
      return { route: 'ESCALATE_TO_CLOUD', doc: docResult, score: effectiveScore };
    }
  }

  /**
   * Rank candidates across dense, sparse, and hybrid modes.
   */
  public rankCandidates(
    queryText: string,
    queryVector?: number[],
    alpha: number = 0.5,
    topK: number = 10
  ): RankCandidatesResult {
    if (this.docIds.length === 0) {
      return { dense: [], sparse: [], hybrid: [] };
    }

    const qVec = queryVector || generateEmbedding(queryText);

    // Dense
    const denseScores = new Map<string, number>();
    for (const id of this.docIds) {
      const v = this.vectors.get(id);
      if (v) {
        denseScores.set(id, cosineSimilarity(v, qVec));
      }
    }
    const denseRanks = Array.from(denseScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    // Sparse
    const bm25Scores = this.bm25.score(queryText);
    const sparseRanks = Array.from(bm25Scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    // Hybrid
    const fused = reciprocalRankFusion(denseRanks, sparseRanks, 60, alpha, 1.0 - alpha);
    const hybridRanks = fused.map(e => e[0]);

    return {
      dense: denseRanks.slice(0, topK),
      sparse: sparseRanks.slice(0, topK),
      hybrid: hybridRanks.slice(0, topK)
    };
  }

  /**
   * Reset to fresh CyberStrike corpus.
   */
  public resetToDefaultCorpus(): void {
    this.documents.clear();
    this.vectors.clear();
    this.docIds = [];
    this.bm25 = new BM25Index();
    this.expectedDim = null;

    const initialDocs = getInitialCorpusWithVectors();
    for (const d of initialDocs) {
      this.addDocument(
        d.id,
        d.text,
        d.vector,
        d.type,
        undefined,
        undefined,
        d.metadata
      );
    }
  }

  public saveToStorage(): void {
    try {
      const docList = Array.from(this.documents.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(docList));
    } catch {
      // LocalStorage quotas or private browsing fallback
    }
  }

  public loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: StoredDocument[] = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.documents.clear();
          this.vectors.clear();
          this.docIds = [];
          this.bm25 = new BM25Index();

          for (const d of parsed) {
            const vec = d.vector && d.vector.length > 0 ? d.vector : generateEmbedding(d.text);
            this.docIds.push(d.id);
            this.vectors.set(d.id, vec);
            this.documents.set(d.id, { ...d, vector: vec });
            this.bm25.addDocument(d.id, d.text);
            if (!this.expectedDim) this.expectedDim = vec.length;
          }
          return true;
        }
      }
    } catch {
      // Load fallback
    }

    this.resetToDefaultCorpus();
    return true;
  }
}
