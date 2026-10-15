/**
 * Security perimeter: Token Bucket Rate Limiter, Payload Sanitizer,
 * Anti-Timing comparison, and CIS/OWASP Security Headers.
 */

export interface TokenBucketState {
  tokens: number;
  capacity: number;
  refillRate: number; // tokens per second
  lastRefillTime: number;
}

export class TokenBucketRateLimiter {
  private capacity: number;
  private refillRate: number;
  private buckets: Map<string, { tokens: number; lastRefill: number }>;

  constructor(capacity: number = 60, refillRate: number = 1.0) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.buckets = new Map();
  }

  public getBucket(clientId: string = 'default'): { tokens: number; lastRefill: number } {
    const now = Date.now() / 1000;
    if (!this.buckets.has(clientId)) {
      this.buckets.set(clientId, { tokens: this.capacity, lastRefill: now });
    }
    const b = this.buckets.get(clientId)!;
    const delta = Math.max(0, now - b.lastRefill);
    b.tokens = Math.min(this.capacity, b.tokens + delta * this.refillRate);
    b.lastRefill = now;
    return b;
  }

  public allowRequest(clientId: string = 'default'): { allowed: boolean; remaining: number; retryAfter?: number } {
    const b = this.getBucket(clientId);
    if (b.tokens >= 1.0) {
      b.tokens -= 1.0;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    } else {
      const waitTime = Math.ceil((1.0 - b.tokens) / this.refillRate);
      return { allowed: false, remaining: 0, retryAfter: Math.max(1, waitTime) };
    }
  }

  public reset(clientId?: string): void {
    if (clientId) {
      this.buckets.delete(clientId);
    } else {
      this.buckets.clear();
    }
  }

  public getState(clientId: string = 'default'): TokenBucketState {
    const b = this.getBucket(clientId);
    return {
      tokens: Number(b.tokens.toFixed(2)),
      capacity: this.capacity,
      refillRate: this.refillRate,
      lastRefillTime: b.lastRefill
    };
  }
}

export class PayloadSanitizer {
  // Unicode BiDi override characters (Trojan Source CVE-2021-42574)
  private static BIDI_CHARS = /[\u202A-\u202E\u2066-\u2069]/;

  public static sanitizeText(text: string, fieldName: string = 'payload'): { valid: boolean; error?: string; cleanText: string } {
    if (text === null || text === undefined) {
      return { valid: true, cleanText: '' };
    }

    // 1. Check for Null Bytes
    if (text.includes('\x00')) {
      return {
        valid: false,
        error: `Inyección de seguridad detectada: Null Byte (\\x00) prohibido en campo '${fieldName}'.`,
        cleanText: text.replace(/\x00/g, '')
      };
    }

    // 2. Check for Trojan Source BiDi Overrides
    if (this.BIDI_CHARS.test(text)) {
      return {
        valid: false,
        error: `Inyección de seguridad detectada: Caracteres Unicode BiDi Trojan Source (CVE-2021-42574) prohibidos en '${fieldName}'.`,
        cleanText: text.replace(this.BIDI_CHARS, '')
      };
    }

    return { valid: true, cleanText: text };
  }
}

/**
 * Constant-time string comparison to prevent timing attacks on API keys.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let dummy = 0;
    for (let i = 0; i < a.length; i++) {
      dummy |= a.charCodeAt(i) ^ a.charCodeAt(i);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const CIS_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Server': 'OpenHybridRAG-Guard/1.0',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};
