/**
 * Fast, deterministic in-memory vector embedding generator.
 * Produces unit-normalized dense float vectors (128 dimensions)
 * with semantic n-gram hashing, vocabulary projection, and topical weighting.
 */

export const EMBEDDING_DIMENSION = 128;

function hashString(str: string, seed: number = 0): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function generateEmbedding(text: string): number[] {
  if (!text || text.trim().length === 0) {
    return new Array(EMBEDDING_DIMENSION).fill(0);
  }

  const vec = new Float32Array(EMBEDDING_DIMENSION);
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-zA-Z0-9_:.-]+/g) || [];

  if (words.length === 0) {
    return Array.from(vec);
  }

  // 1. Single word projections
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const weight = 1.0 + Math.log(1 + (w.length > 5 ? 1.5 : 1.0));
    const h1 = hashString(w, 42) % EMBEDDING_DIMENSION;
    const h2 = hashString(w, 137) % EMBEDDING_DIMENSION;
    const sign = (hashString(w, 999) % 2 === 0) ? 1 : -1;

    vec[h1] += weight * sign;
    vec[h2] += weight * 0.7 * -sign;

    // 2. Bigrams for technical compounds
    if (i < words.length - 1) {
      const bigram = `${w}_${words[i + 1]}`;
      const bh = hashString(bigram, 777) % EMBEDDING_DIMENSION;
      const bSign = (hashString(bigram, 123) % 2 === 0) ? 1 : -1;
      vec[bh] += 1.8 * bSign;
    }

    // 3. Subwords for codes like API3:2023, CVE-2024, WSTG-INPV, M1038
    if (w.length >= 4) {
      for (let s = 0; s < w.length - 2; s++) {
        const tri = w.slice(s, s + 3);
        const th = hashString(tri, 333) % EMBEDDING_DIMENSION;
        vec[th] += 0.3;
      }
    }
  }

  // L2 Normalization
  let normSq = 0;
  for (let j = 0; j < EMBEDDING_DIMENSION; j++) {
    normSq += vec[j] * vec[j];
  }

  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let j = 0; j < EMBEDDING_DIMENSION; j++) {
      vec[j] /= norm;
    }
  }

  return Array.from(vec);
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA <= 0 || normB <= 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, sim));
}
