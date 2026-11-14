/**
 * Fast token estimate without a tokenizer. Used for budgets, not for billing.
 * Calibrated for Qwen-family BPE on Italian/English prose: ~3.6 chars per token,
 * with a correction for digits and punctuation (they tokenize densely).
 * The real count from llama-server (/tokenize) replaces it where precision matters.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let dense = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // digits and ASCII punctuation
    if ((c >= 48 && c <= 57) || (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) {
      dense++;
    }
  }
  const plain = text.length - dense;
  return Math.max(1, Math.ceil(plain / 3.6 + dense / 1.5));
}
