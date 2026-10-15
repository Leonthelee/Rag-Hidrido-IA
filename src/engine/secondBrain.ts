import { SecondBrainNote } from './types';

const STORAGE_KEY = 'open_hybrid_rag_second_brain_v1';

export class SecondBrain {
  public notes: SecondBrainNote[] = [];

  constructor() {
    this.loadFromStorage();
  }

  public saveInteraction(
    query: string,
    answer: string,
    source: string,
    latencyMs: number,
    metadata?: Record<string, any>
  ): string {
    const timestamp = new Date();
    const dateFormatted = timestamp.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = `SB-${dateFormatted}-${Math.floor(Math.random() * 900 + 100)}`;

    const tags = ['open-hybrid-rag', 'rag-verified'];
    if (source.includes('cloud')) {
      tags.push('cloud-promoted');
    } else {
      tags.push('local-resolved');
    }

    const similarity = metadata?.similarity_score ?? 0.0;
    const route = metadata?.route ?? 'UNKNOWN';

    const markdown = `---
id: "${id}"
query: "${query.replace(/"/g, '\\"')}"
source: "${source}"
similarity_score: ${similarity}
route: "${route}"
latency_ms: ${latencyMs}
created_at: "${timestamp.toISOString()}"
tags: [${tags.map(t => `"${t}"`).join(', ')}]
---

# ${query}

**Ruta Tomada:** \`${route}\` | **Fuente:** \`${source}\` | **Latencia:** \`${latencyMs}ms\`

## Respuesta Verificada

${answer}

---
*Indexado automáticamente por Open Hybrid RAG Gateway.*
`;

    const note: SecondBrainNote = {
      id,
      query,
      answer,
      source,
      latency_ms: latencyMs,
      similarity_score: similarity,
      route,
      created_at: timestamp.toISOString(),
      markdown
    };

    this.notes.unshift(note);
    this.saveToStorage();
    return id;
  }

  public deleteNote(id: string): boolean {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx !== -1) {
      this.notes.splice(idx, 1);
      this.saveToStorage();
      return true;
    }
    return false;
  }

  public clear(): void {
    this.notes = [];
    this.saveToStorage();
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.notes));
    } catch {
      // Storage fallback
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.notes = JSON.parse(raw);
        return;
      }
    } catch {
      // Fallback
    }

    // Add 1 sample verified note
    this.notes = [
      {
        id: 'SB-20261013223238-706',
        query: '¿Cómo mitigar OWASP API3:2023 Broken Object Property Level Authorization (BOPLA)?',
        answer: 'Para mitigar API3:2023 Broken Object Property Level Authorization (BOPLA / Mass Assignment):\n1. Utilizar DTOs explícitos y esquemas de validación estrictos (ej. Pydantic con extra="forbid").\n2. Definir listas blancas inmutables de campos permitidos en modificaciones.\n3. Nunca enlazar objetos del payload HTTP directamente a modelos ORM o entidades de base de datos.',
        source: 'local_slm_rag',
        latency_ms: 142.5,
        similarity_score: 0.8286,
        route: 'RESOLVE_LOCAL_MED',
        created_at: '2026-10-13T22:32:38Z',
        markdown: `---
id: "SB-20261013223238-706"
query: "¿Cómo mitigar OWASP API3:2023 Broken Object Property Level Authorization (BOPLA)?"
source: "local_slm_rag"
similarity_score: 0.8286
route: "RESOLVE_LOCAL_MED"
latency_ms: 142.5
created_at: "2026-10-13T22:32:38Z"
tags: ["open-hybrid-rag", "rag-verified", "local-resolved"]
---

# ¿Cómo mitigar OWASP API3:2023 Broken Object Property Level Authorization (BOPLA)?

**Ruta Tomada:** \`RESOLVE_LOCAL_MED\` | **Fuente:** \`local_slm_rag\` | **Latencia:** \`142.5ms\`

## Respuesta Verificada

Para mitigar API3:2023 Broken Object Property Level Authorization (BOPLA / Mass Assignment):
1. Utilizar DTOs explícitos y esquemas de validación estrictos (ej. Pydantic con extra="forbid").
2. Definir listas blancas inmutables de campos permitidos en modificaciones.
3. Nunca enlazar objetos del payload HTTP directamente a modelos ORM o entidades de base de datos.

---
*Indexado automáticamente por Open Hybrid RAG Gateway.*`
      }
    ];
  }
}
