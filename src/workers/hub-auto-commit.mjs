const adoption = /^(?:(?:确认|同意)[，,:：]\s*)?(?:就(?:用|采用|选)|(?:我们)?(?:决定|确认|同意)(?:采用|使用|选用|改用|替换为|用|选)|采用|改用|替换为|按.+(?:执行|落地)|(?:(?:we|i)(?: (?:have )?decided to |['’]ve decided to | will )|let['’]s )?(?:use|adopt|choose|switch to|replace .+ with)\s)/iu;
const tentative = /[?？]|(?:如果|假设|是否|试试|暂且|暂不|不(?:要|用|采用|选)|别用|撤回|再考虑)|\b(?:if|maybe|might|perhaps|not|never|instead of|try|temporarily|disregard|scratch that|consider)\b/iu;
const label = /(?:方案\s*|\b(?:option|plan)\s+)([a-z0-9]+)(?![a-z0-9])/iu;

function plainLines(text) {
  let fence = null;
  const lines = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (!fence && !/^\s*(?:>|["'`“‘]|\s{4})/u.test(line)) {
      const clean = line.trim();
      if (clean) lines.push(clean);
    }
  }
  return lines;
}

const canonical = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const namesOption = (text, code) => {
  const normalized = canonical(code);
  return normalized && ` ${canonical(text)} `.includes(` ${normalized} `);
};

export function evaluateAutoCommit({ scope, rejectedCount, ops, evidence, authoredUserText, assistantText, autopilot }) {
  const deny = reason => ({ eligible: false, reason });
  if (autopilot?.enabled !== true || autopilot.autoCommit?.project === false) return deny('disabled');
  if (scope !== 'project') return deny('user_scope');
  if (rejectedCount || !ops.length || ops.some(op => op.op !== 'ASSERT' && op.op !== 'SUPERSEDE')) return deny('mixed_or_rejected');
  if (ops.some(op => op.op === 'SUPERSEDE') && autopilot.autoCommit?.supersede === false) return deny('supersede_disabled');
  if (!Array.isArray(evidence) || evidence.length !== ops.length) return deny('missing_evidence');
  const userLines = plainLines(authoredUserText);
  const assistantLines = plainLines(assistantText);
  if (userLines.some(line => tentative.test(line))) return deny('tentative_or_withdrawn');
  for (const [index, op] of ops.entries()) {
    const candidates = evidence.filter(item => item?.op_index === index);
    const proof = candidates[0];
    if (candidates.length !== 1 || !userLines.includes(proof.user_quote) ||
        !adoption.test(proof.user_quote)) return deny('unverified_user_adoption');

    const choice = label.exec(proof.user_quote)?.[1].toLowerCase();
    if (choice || !namesOption(proof.user_quote, op.option_code)) {
      if (typeof proof.assistant_quote !== 'string' || !assistantLines.some(line => !tentative.test(line) && line.includes(proof.assistant_quote)) ||
          !namesOption(proof.assistant_quote, op.option_code) ||
          (choice && label.exec(proof.assistant_quote)?.[1].toLowerCase() !== choice)) return deny('unverified_option');
    }
    if (op.op === 'SUPERSEDE') {
      const quote = proof.falsification_quote;
      if (typeof quote !== 'string' || !canonical(quote) || canonical(quote) === canonical(proof.user_quote) ||
          !namesOption(quote, op.reason) ||
          ![...userLines, ...assistantLines].some(line => !tentative.test(line) && line.includes(quote))) return deny('unverified_falsification');
    }
  }
  return { eligible: true, reason: 'verified_project_adoption' };
}
