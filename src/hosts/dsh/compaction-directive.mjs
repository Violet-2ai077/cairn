export function appendCompactionDirective(messages, directive) {
  if (!Array.isArray(messages)) return messages;
  const index = messages.findLastIndex(message => message?.role === 'user');
  if (index < 0) return [...messages, { role: 'user', content: [{ type: 'text', text: directive }] }];
  const message = messages[index];
  let content;
  if (typeof message.content === 'string') content = message.content + '\n\n' + directive;
  else {
    content = [...(message.content ?? [])];
    const last = content.at(-1);
    if (last?.type === 'text') content[content.length - 1] = { ...last, text: last.text + '\n\n' + directive };
    else content.push({ type: 'text', text: directive });
  }
  return messages.with(index, { ...message, content });
}
