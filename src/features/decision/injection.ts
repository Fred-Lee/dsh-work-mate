/**
 * Deterministic pre-screen for the injection judgement (change `injection-prescreen`).
 *
 * Live evidence that motivated this: a proposal whose notes were ordinary Chinese prose
 * ("验收 review-severity 与 task-satisfied 两个判断节点…") came back `risky` → the proposal was
 * marked `provenance.untrusted`. A judge that flags harmless text teaches users to ignore it.
 *
 * Policy: only text that actually LOOKS like an instruction aimed at an agent goes to the model.
 * This is a screen, not a detector: a match never decides anything by itself — it only keeps
 * the strict model path for suspicious text and saves a judgement call for the rest.
 */
const PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Instruction override / prompt hijack
  { name: 'override-en', pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b/i },
  { name: 'override-zh', pattern: /(忽略|无视|忘掉|不要理会)[^。\n]{0,20}(以上|之前|上述|先前|前面|所有)/ },
  { name: 'role-hijack-en', pattern: /\b(you are now|act as|pretend to be|system prompt|new instructions?)\b/i },
  { name: 'role-hijack-zh', pattern: /(你现在是|从现在开始你是|扮演|系统提示词|新的指令)/ },
  // Secret exfiltration
  { name: 'exfil-en', pattern: /\b(reveal|leak|print|dump|expose)\b[^.\n]{0,30}\b(secret|token|api[ _-]?key|password|credential)/i },
  { name: 'exfil-zh', pattern: /(泄露|输出|打印|告诉我)[^。\n]{0,16}(密钥|口令|密码|token|凭据)/i },
  // Gate / approval bypass
  { name: 'gate-bypass-en', pattern: /\b(skip|bypass|ignore)\b[^.\n]{0,30}\b(gate|gates|check|checks|approval|review|guardrail)/i },
  { name: 'gate-bypass-zh', pattern: /(跳过|绕过|忽略)[^。\n]{0,16}(门禁|检查|审批|审查|校验)/ },
  { name: 'self-approve', pattern: /\bapprove\b[^.\n]{0,20}\b(your own|yourself|own work)\b|自行批准|自己批准/i },
  // Destructive or networked actions embedded in text
  { name: 'dangerous-command', pattern: /(^|\s)(rm\s+-rf|sudo\s|chmod\s+777|curl\s+https?:\/\/|wget\s+https?:\/\/)/i },
]

export interface PrescreenResult {
  /** True when the text carries injection markers and deserves a model judgement. */
  suspicious: boolean
  /** Which markers matched (diagnostics; never a verdict). */
  markers: string[]
}

/** Screen text for agent-directed instruction markers. Pure and cheap: no model, no IO. */
export function prescreenInjection(text: string): PrescreenResult {
  const markers = PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.name)
  return { suspicious: markers.length > 0, markers }
}
