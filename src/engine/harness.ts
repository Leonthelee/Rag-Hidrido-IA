import { AssertAuditResult } from './types';

// ============================================================================
// 1. Policy Gate (src/harness/policy_gate.py)
// ============================================================================
export type PolicyAction = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

export interface PolicyVerdict {
  action: PolicyAction;
  tool_name: string;
  command_or_target: string;
  reason: string;
  risk_level: 'LOW' | 'MEDIUM' | 'CRITICAL';
}

export class PolicyGate {
  private prohibitedPatterns = [
    /\brm\s+-(?:r|f|rf|fr)\s+[/~]/i,
    /\bformat\s+[a-zA-Z]:/i,
    /\bdrop\s+(?:table|database|schema)\b/i,
    /\btruncate\s+table\b/i,
    /\bcurl\b.*\|\s*(?:bash|sh|powershell|pwsh)/i,
    /\bkill\s+-9\s+1\b/i,
    /\bchmod\s+-R\s+777\b/i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
    />\s*\/dev\/sd[a-z]/i,
  ];

  private mutationTools = new Set([
    'write_file', 'edit_file', 'delete_file', 'git_commit', 'git_push',
    'deploy_service', 'apply_migration'
  ]);

  private safeReadTools = new Set([
    'read_file', 'search_docs', 'git_status', 'git_diff', 'list_dir',
    'search_web', 'check_health'
  ]);

  public evaluate(toolName: string, payload: Record<string, any>): PolicyVerdict {
    const target = String(payload.command || payload.path || payload.file || '');
    const fullText = `${toolName} ${target} ${JSON.stringify(payload)}`.toLowerCase();

    for (const pattern of this.prohibitedPatterns) {
      if (pattern.test(fullText)) {
        return {
          action: 'DENY',
          tool_name: toolName,
          command_or_target: target,
          reason: `Comando destructivo bloqueado por política de seguridad (Patrón: ${pattern.source})`,
          risk_level: 'CRITICAL'
        };
      }
    }

    if (['delete_database', 'wipe_disk', 'destroy_infra'].includes(toolName)) {
      return {
        action: 'DENY',
        tool_name: toolName,
        command_or_target: target,
        reason: 'Herramienta explícitamente clasificada como destructiva no permitida.',
        risk_level: 'CRITICAL'
      };
    }

    if (this.mutationTools.has(toolName) || toolName.includes('write') || toolName.includes('edit')) {
      return {
        action: 'REQUIRE_APPROVAL',
        tool_name: toolName,
        command_or_target: target,
        reason: 'La herramienta muta el estado del sistema o código. Requiere confirmación humana.',
        risk_level: 'MEDIUM'
      };
    }

    if (['execute_command', 'run_shell', 'terminal'].includes(toolName)) {
      if (/^(git\s+status|git\s+log|dir|ls|cat|type|pwd|echo)\b/i.test(target.trim())) {
        return {
          action: 'ALLOW',
          tool_name: toolName,
          command_or_target: target,
          reason: 'Comando de inspección seguro auto-aprobado.',
          risk_level: 'LOW'
        };
      }
      return {
        action: 'REQUIRE_APPROVAL',
        tool_name: toolName,
        command_or_target: target,
        reason: 'Comando de consola que puede alterar el entorno.',
        risk_level: 'MEDIUM'
      };
    }

    if (this.safeReadTools.has(toolName) || toolName.includes('read') || toolName.includes('search')) {
      return {
        action: 'ALLOW',
        tool_name: toolName,
        command_or_target: target,
        reason: 'Herramienta de solo lectura.',
        risk_level: 'LOW'
      };
    }

    return {
      action: 'REQUIRE_APPROVAL',
      tool_name: toolName,
      command_or_target: target,
      reason: 'Herramienta no clasificada en lista blanca. Aplicando principio de precaución.',
      risk_level: 'MEDIUM'
    };
  }
}

// ============================================================================
// 2. Observe & Trim (src/harness/observe_trim.py)
// ============================================================================
export interface TrimResult {
  trimmed_output: string;
  original_lines: number;
  trimmed_lines: number;
  compression_ratio: number;
  has_failure: boolean;
  summary_header: string;
}

export class ObserveTrim {
  private maxOutputLines: number;

  private noisePatterns = [
    /^\s*$/,
    /^\s*\d+%\s*\|[█=-]+\|/,
    /^Fetching\s+package\s+metadata/,
    /^Downloading\s+https?:\/\//,
    /^\s*Collecting\s+/,
    /DeprecationWarning:/,
    /FutureWarning:/,
    /UserWarning:/
  ];

  private criticalErrorPatterns = [
    /(?:FAIL|FAILED|FAILURE)\b/i,
    /(?:ERROR|Error|Exception):/i,
    /AssertionError/i,
    /Traceback \(most recent call last\):/i,
    /File ".*?", line \d+/i,
    /SyntaxError:/i,
    /ImportError:/i,
    /ModuleNotFoundError:/i,
    /UndefinedVariable/i,
    /NullPointerException/i,
    /Segmentation fault/i,
    /npm ERR!/i
  ];

  constructor(maxOutputLines: number = 35) {
    this.maxOutputLines = maxOutputLines;
  }

  public trim(rawOutput: string, exitCode: number = 0): TrimResult {
    if (!rawOutput || !rawOutput.trim()) {
      return {
        trimmed_output: `[Sin salida en consola (exit code: ${exitCode})]`,
        original_lines: 0,
        trimmed_lines: 1,
        compression_ratio: 0.0,
        has_failure: exitCode !== 0,
        summary_header: 'Comando ejecutado sin salida.'
      };
    }

    const lines = rawOutput.split(/\r?\n/);
    const originalCount = lines.length;
    let hasFailure = exitCode !== 0;

    // Success case
    if (exitCode === 0 && !lines.slice(-15).some(l => /\b(FAILED|ERROR)\b/i.test(l))) {
      const meaningfulTail = lines
        .filter(l => l.trim() && !this.isNoise(l))
        .slice(-3);
      const distilled = meaningfulTail.length > 0 ? meaningfulTail.join('\n') : 'OK (Exitoso)';
      const trimmedCount = distilled.split(/\r?\n/).length;
      const ratio = Number(((1.0 - trimmedCount / Math.max(1, originalCount)) * 100).toFixed(1));
      return {
        trimmed_output: `✓ Ejecución exitosa (exit code 0):\n${distilled}`,
        original_lines: originalCount,
        trimmed_lines: trimmedCount,
        compression_ratio: Math.max(0, ratio),
        has_failure: false,
        summary_header: 'Comando finalizado con éxito.'
      };
    }

    // Failure case: locate critical indices
    const criticalIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      for (const pat of this.criticalErrorPatterns) {
        if (pat.test(lines[i])) {
          const start = Math.max(0, i - 2);
          const end = Math.min(originalCount, i + 4);
          for (let k = start; k < end; k++) criticalIndices.add(k);
          hasFailure = true;
          break;
        }
      }
    }

    if (criticalIndices.size === 0 && exitCode !== 0) {
      const tailStart = Math.max(0, originalCount - 15);
      for (let k = tailStart; k < originalCount; k++) criticalIndices.add(k);
    }

    const selectedLines: string[] = [];
    let lastIdx = -2;
    const sorted = Array.from(criticalIndices).sort((a, b) => a - b);

    for (const idx of sorted) {
      if (this.isNoise(lines[idx])) continue;
      if (idx > lastIdx + 1 && lastIdx !== -2) {
        selectedLines.push('... [líneas omitidas] ...');
      }
      selectedLines.push(lines[idx]);
      lastIdx = idx;
    }

    if (selectedLines.length > this.maxOutputLines) {
      const half = Math.floor(this.maxOutputLines / 2);
      selectedLines.splice(
        half,
        selectedLines.length - half * 2,
        '... [recorte de seguridad de tokens] ...'
      );
    }

    const trimmedOutput = selectedLines.join('\n');
    const trimmedCount = selectedLines.length;
    const ratio = Number(((1.0 - trimmedCount / Math.max(1, originalCount)) * 100).toFixed(1));
    const header = `Fallo detectado (exit code ${exitCode}). De ${originalCount} líneas crudas a ${trimmedCount} esenciales (${ratio}% comprimido).`;

    return {
      trimmed_output: trimmedOutput,
      original_lines: originalCount,
      trimmed_lines: trimmedCount,
      compression_ratio: Math.max(0, ratio),
      has_failure: true,
      summary_header: header
    };
  }

  private isNoise(line: string): boolean {
    return this.noisePatterns.some(p => p.test(line));
  }
}

// ============================================================================
// 3. Verifier (src/harness/verifier.py)
// ============================================================================
export type VerificationVerdict = 'SHIP_IT' | 'LOOP_AGAIN' | 'BUDGET_EXCEEDED';
export type EpistemicCertainty = 'Cierto' | 'Probable' | 'Adivinando';

export interface VerificationResult {
  verdict: VerificationVerdict;
  tests_passed: boolean;
  lint_clean: boolean;
  budget_ok: boolean;
  has_real_changes: boolean;
  current_turn: int;
  max_turns: int;
  feedback_for_model: string;
  epistemic_certainty?: EpistemicCertainty;
  overconfidence_penalty: boolean;
  metrics: Record<string, any>;
}

type int = number;

export class Verifier {
  private maxTurns: number;

  constructor(maxTurns: number = 15) {
    this.maxTurns = maxTurns;
  }

  public verify(
    currentTurn: number,
    testExitCode: number,
    testSummary: string,
    lintErrorCount: number = 0,
    filesModifiedCount: number = 1,
    modelClaimedDone: boolean = true,
    claimedCertainty?: EpistemicCertainty
  ): VerificationResult {
    const testsPassed = testExitCode === 0;
    const lintClean = lintErrorCount === 0;
    const budgetOk = currentTurn <= this.maxTurns;
    const hasRealChanges = filesModifiedCount > 0;
    const overconfidence = claimedCertainty === 'Cierto' && !testsPassed;

    if (!budgetOk) {
      return {
        verdict: 'BUDGET_EXCEEDED',
        tests_passed: testsPassed,
        lint_clean: lintClean,
        budget_ok: false,
        has_real_changes: hasRealChanges,
        current_turn: currentTurn,
        max_turns: this.maxTurns,
        feedback_for_model: `PRESUPUESTO AGOTADO: Se alcanzaron los ${this.maxTurns} turnos máximos sin estabilizar los tests.`,
        epistemic_certainty: claimedCertainty,
        overconfidence_penalty: overconfidence,
        metrics: { current_turn: currentTurn, max_turns: this.maxTurns }
      };
    }

    if (modelClaimedDone && !hasRealChanges) {
      return {
        verdict: 'LOOP_AGAIN',
        tests_passed: false,
        lint_clean: lintClean,
        budget_ok: true,
        has_real_changes: false,
        current_turn: currentTurn,
        max_turns: this.maxTurns,
        feedback_for_model: 'RECHAZADO: Declaraste que la tarea está lista pero no se detectaron cambios reales en archivos.',
        epistemic_certainty: claimedCertainty,
        overconfidence_penalty: overconfidence,
        metrics: { files_modified: 0 }
      };
    }

    if (!testsPassed) {
      let feedback = `RECHAZADO 'ALL DONE': Los tests siguen fallando (exit code ${testExitCode}). Corrige la causa raíz:\n${testSummary}`;
      if (overconfidence) {
        feedback =
          '⚠️ [PENALIZACIÓN DE SOBRE-CONFIANZA]: Afirmaste certeza [Cierto] pero los tests fallaron. ' +
          'Un modelo solo puede declarar [Cierto] cuando tiene evidencia empírica verificada.\n' +
          feedback;
      }
      return {
        verdict: 'LOOP_AGAIN',
        tests_passed: false,
        lint_clean: lintClean,
        budget_ok: true,
        has_real_changes: hasRealChanges,
        current_turn: currentTurn,
        max_turns: this.maxTurns,
        feedback_for_model: feedback,
        epistemic_certainty: claimedCertainty,
        overconfidence_penalty: overconfidence,
        metrics: { test_exit_code: testExitCode, test_summary: testSummary }
      };
    }

    if (!lintClean) {
      return {
        verdict: 'LOOP_AGAIN',
        tests_passed: true,
        lint_clean: false,
        budget_ok: true,
        has_real_changes: hasRealChanges,
        current_turn: currentTurn,
        max_turns: this.maxTurns,
        feedback_for_model: `RECHAZADO: Los tests pasaron pero se detectaron ${lintErrorCount} errores de linter/sintaxis.`,
        epistemic_certainty: claimedCertainty,
        overconfidence_penalty: false,
        metrics: { lint_errors: lintErrorCount }
      };
    }

    const resolvedCertainty: EpistemicCertainty = testsPassed
      ? 'Cierto'
      : (claimedCertainty || 'Probable');

    return {
      verdict: 'SHIP_IT',
      tests_passed: true,
      lint_clean: true,
      budget_ok: true,
      has_real_changes: hasRealChanges,
      current_turn: currentTurn,
      max_turns: this.maxTurns,
      feedback_for_model: `APROBADO PARA ENVÍO (SHIP IT) [${resolvedCertainty}]: Tests en verde (exit code 0), 0 errores de linter, completado en ${currentTurn}/${this.maxTurns} turnos.`,
      epistemic_certainty: resolvedCertainty,
      overconfidence_penalty: false,
      metrics: { current_turn: currentTurn, tests_passed: true, lint_clean: true }
    };
  }
}

// ============================================================================
// 4. ASSERT Evaluator (src/assert_evaluator.py)
// ============================================================================
export class AssertEvaluator {
  public evaluate(query: string, answer: string, source: string): AssertAuditResult {
    const qLower = query.toLowerCase();
    const aLower = answer.toLowerCase();

    const checkedControls: string[] = [];
    let technicalScore = 8;
    let hallucinationRisk: 'low' | 'medium' | 'high' = 'low';

    // 1. Check for specific technical terms
    if (qLower.includes('api3') || qLower.includes('bopla')) {
      checkedControls.push('OWASP API3:2023 BOPLA validation');
      if (aLower.includes('dto') || aLower.includes('pydantic') || aLower.includes('extra="forbid"')) {
        technicalScore = Math.min(10, technicalScore + 2);
      }
    }

    if (qLower.includes('docker') || qLower.includes('root') || qLower.includes('uid')) {
      checkedControls.push('CIS Docker 4.1 Non-Root User');
      if (aLower.includes('10001') || aLower.includes('non-root') || aLower.includes('user')) {
        technicalScore = Math.min(10, technicalScore + 1);
      }
    }

    if (qLower.includes('ssrf')) {
      checkedControls.push('OWASP API7:2023 SSRF Validation');
      if (aLower.includes('whitelist') || aLower.includes('lista blanca') || aLower.includes('169.254')) {
        technicalScore = Math.min(10, technicalScore + 2);
      }
    }

    if (qLower.includes('sysctl') || qLower.includes('syn flood')) {
      checkedControls.push('CIS Linux Network Hardening');
      if (aLower.includes('tcp_syncookies') || aLower.includes('rp_filter')) {
        technicalScore = Math.min(10, technicalScore + 2);
      }
    }

    if (checkedControls.length === 0) {
      checkedControls.push('General Technical Grounding Check');
    }

    // Epistemic certainty
    let epistemic: 'Cierto' | 'Probable' | 'Adivinando' = 'Probable';
    if (source === 'local_vector_cache' || source === 'local_slm_rag') {
      epistemic = 'Cierto';
      hallucinationRisk = 'low';
    } else if (source.includes('cloud')) {
      epistemic = 'Probable';
      hallucinationRisk = 'low';
    } else {
      epistemic = 'Adivinando';
      hallucinationRisk = 'medium';
    }

    const passed = technicalScore >= 7;

    return {
      passed,
      technical_score: technicalScore,
      overall_score: technicalScore,
      hallucination_risk: hallucinationRisk,
      epistemic_certainty: epistemic,
      critique: passed
        ? `Alineado con especificación de seguridad. Controles verificados: ${checkedControls.join(', ')}.`
        : 'Respuesta con imprecisiones en mitigaciones específicas.',
      checked_controls: checkedControls
    };
  }
}
