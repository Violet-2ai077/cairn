// Apply before excerpt selection: distilling first can separate a private value from its label.
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/giu;
const AUTH = /(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic)[ \t]+)[^\s,;'"{}]+/giu;
const ASSIGNMENT = /((?:\b|(?<=_))(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|token)["']?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,"'{}\]&;]+)/giu;

export function redactToolOutput(value) {
  return String(value ?? '').replace(PRIVATE_KEY, '<redacted>')
    .replace(AUTH, '$1<redacted>')
    .replace(ASSIGNMENT, (_, key, raw) => {
      const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '';
      return key + quote + '<redacted>' + quote;
    });
}

export function redactToolEvidence(tools) {
  return tools.map(tool => tool && typeof tool.output === 'string' ? { ...tool, output: redactToolOutput(tool.output) } : tool);
}
