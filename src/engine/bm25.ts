/**
 * In-memory Okapi BM25 Index and Reciprocal Rank Fusion (RRF).
 * Faithfully ports src/bm25.py with technical tokenizer preserving
 * identifiers, composite error codes (e.g., API3:2023, HTTP_422, CVE-2024-1234, M1042).
 */

export class BM25Index {
  public k1: number;
  public b: number;
  public docLengths: Map<string, number>;
  public docTokens: Map<string, Map<string, number>>;
  public docCount: number;
  public avgDocLength: number;
  public docFreqs: Map<string, number>;

  constructor(k1: number = 1.5, b: number = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docLengths = new Map();
    this.docTokens = new Map();
    this.docCount = 0;
    this.avgDocLength = 0.0;
    this.docFreqs = new Map();
  }

  /**
   * Technical tokenizer: preserves identifiers, error codes with hyphens, numbers, colons,
   * removing peripheral punctuation.
   */
  public static tokenize(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const rawTokens = lower.match(/[a-zA-Z0-9_:\.\-]+/g) || [];
    const tokens: string[] = [];
    const punctuationChars = /^[\.\:,;\!\?\(\)\[\]\{\}'"]+|[\.\:,;\!\?\(\)\[\]\{\}'"]+$/g;

    for (const t of rawTokens) {
      const cleaned = t.replace(punctuationChars, '');
      if (cleaned.length > 1 || /^\d+$/.test(cleaned)) {
        tokens.push(cleaned);
      }
    }
    return tokens;
  }

  /**
   * Adds or replaces a document in the lexical index.
   */
  public addDocument(docId: string, text: string): void {
    if (this.docTokens.has(docId)) {
      this.deleteDocument(docId);
    }

    const tokens = BM25Index.tokenize(text);
    const tokenCounts = new Map<string, number>();

    for (const token of tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }

    const docLen = tokens.length;
    this.docTokens.set(docId, tokenCounts);
    this.docLengths.set(docId, docLen);
    this.docCount += 1;

    for (const term of tokenCounts.keys()) {
      this.docFreqs.set(term, (this.docFreqs.get(term) || 0) + 1);
    }

    let totalLength = 0;
    for (const len of this.docLengths.values()) {
      totalLength += len;
    }
    this.avgDocLength = this.docCount > 0 ? totalLength / this.docCount : 0.0;
  }

  /**
   * Batch ingest documents into the lexical index.
   */
  public addDocumentsBatch(docs: Array<{ docId: string; text: string }>): void {
    for (const d of docs) {
      this.addDocument(d.docId, d.text);
    }
  }

  /**
   * Deletes a document and recalculates global BM25 stats.
   */
  public deleteDocument(docId: string): boolean {
    if (!this.docTokens.has(docId)) {
      return false;
    }

    const oldCounts = this.docTokens.get(docId)!;
    this.docTokens.delete(docId);
    this.docLengths.delete(docId);
    this.docCount -= 1;

    for (const term of oldCounts.keys()) {
      const curr = this.docFreqs.get(term) || 0;
      if (curr <= 1) {
        this.docFreqs.delete(term);
      } else {
        this.docFreqs.set(term, curr - 1);
      }
    }

    let totalLength = 0;
    for (const len of this.docLengths.values()) {
      totalLength += len;
    }
    this.avgDocLength = this.docCount > 0 ? totalLength / this.docCount : 0.0;
    return true;
  }

  /**
   * Calculates Inverse Document Frequency with probabilistic smoothing.
   */
  private idf(term: string): number {
    const n_t = this.docFreqs.get(term) || 0;
    if (n_t === 0) return 0.0;
    return Math.log(1.0 + (this.docCount - n_t + 0.5) / (n_t + 0.5));
  }

  /**
   * Computes BM25 score for all matching documents for the query.
   */
  public score(query: string): Map<string, number> {
    const queryTokens = BM25Index.tokenize(query);
    const scores = new Map<string, number>();
    if (queryTokens.length === 0 || this.docCount === 0) {
      return scores;
    }

    for (const [docId, tokenCounts] of this.docTokens.entries()) {
      const docLen = this.docLengths.get(docId) || 0;
      const lenNorm =
        1.0 - this.b + this.b * (this.avgDocLength > 0 ? docLen / this.avgDocLength : 1.0);
      let docScore = 0.0;

      for (const qTerm of queryTokens) {
        const f_td = tokenCounts.get(qTerm) || 0;
        if (f_td > 0) {
          const termIdf = this.idf(qTerm);
          const num = f_td * (this.k1 + 1.0);
          const denom = f_td + this.k1 * lenNorm;
          docScore += termIdf * (num / denom);
        }
      }

      if (docScore > 0) {
        scores.set(docId, docScore);
      }
    }

    return scores;
  }

  /**
   * Returns top_k documents sorted by BM25 relevance score.
   */
  public rank(query: string, topK: number = 10): Array<[string, number]> {
    const scores = this.score(query);
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, topK);
  }
}

/**
 * Reciprocal Rank Fusion (RRF - Cormack et al.).
 * Combines different scoring scales (continuous dense vectors vs discrete BM25 scores).
 */
export function reciprocalRankFusion(
  denseRanks: string[],
  sparseRanks: string[],
  k: number = 60,
  weightDense: number = 0.5,
  weightSparse: number = 0.5
): Array<[string, number]> {
  const rrfScores = new Map<string, number>();

  denseRanks.forEach((docId, rank) => {
    const s = weightDense / (k + (rank + 1));
    rrfScores.set(docId, (rrfScores.get(docId) || 0.0) + s);
  });

  sparseRanks.forEach((docId, rank) => {
    const s = weightSparse / (k + (rank + 1));
    rrfScores.set(docId, (rrfScores.get(docId) || 0.0) + s);
  });

  const sorted = Array.from(rrfScores.entries()).sort((a, b) => b[1] - a[1]);
  return sorted;
}
