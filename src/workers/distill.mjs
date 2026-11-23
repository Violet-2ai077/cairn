// Cairn Workers: Deterministic High-Noise Coding Trajectory Distiller (src/workers/distill.mjs)
// Pure functions, zero LLM calls, zero host coupling.
// Accepts generic turn structures `{ turn, user, assistant, tools: [{ name, target, ok, exit_code, output }] }`.

import { stripTaskMarker } from '../kernel/marker.mjs';

const HIGH_SIGNAL_LINE_REGEX =
  /(?:\b(?:error|fail|failed|failure|exception|fatal|panic|conflict|timeout|timed out|stale_read\w*|p50|p90|p95|p99|latency|qps|rps|throughput|oom|econn\w*|eperm|ebusy|enoent|err_\w+|exit[ _]code|passed|failing)\b|\b\d+(?:\.\d+)?\s*(?:ms|s|sec|%|mb|gb|kb|req\/s|ops\/s)\b)/i;

const FENCED_CODE_BLOCK_REGEX = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;

export function truncateHeadTail(text, maxChars, marker = '\n...[truncated]...\n') {
  const str = String(text ?? '').trim();
  if (str.length <= maxChars) {
    return str;
  }
  const available = Math.max(0, maxChars - marker.length);
  const headLen = Math.ceil(available * 0.7);
  const tailLen = Math.max(0, available - headLen);
  return `${str.slice(0, headLen)}${marker}${tailLen > 0 ? str.slice(str.length - tailLen) : ''}`;
}

/**
 * Distills a single generic tool invocation `{ name, target, ok, exit_code, output }`.
 */
export function distillToolEvent(
  tool = {},
  { maxPerToolChars = 500, maxHighSignalLines = 6 } = {}
) {
  const name = String(tool.name ?? 'tool').trim() || 'tool';
  const target = tool.target !== undefined && tool.target !== null ? String(tool.target).trim() : '';
  const hasExplicitOk = typeof tool.ok === 'boolean';
  const exitCode =
    typeof tool.exit_code === 'number' ? tool.exit_code : null;
  const isOk = hasExplicitOk ? tool.ok : exitCode === null || exitCode === 0;
  const statusLabel = isOk ? 'OK' : 'ERROR';
  const exitSuffix = exitCode !== null ? ` (exit_code=${exitCode})` : '';
  const targetSuffix = target ? ` target="${target}"` : '';

  const header = `[Tool:${name}] status=${statusLabel}${exitSuffix}${targetSuffix}`;
  const rawOutput = String(tool.output ?? '').trim();
  if (!rawOutput) {
    return header;
  }

  const lines = rawOutput.split(/\r?\n/);
  const highSignalLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (HIGH_SIGNAL_LINE_REGEX.test(trimmed)) {
      highSignalLines.push(trimmed);
      if (highSignalLines.length >= maxHighSignalLines) {
        break;
      }
    }
  }

  let body;
  if (highSignalLines.length > 0) {
    const omittedCount = Math.max(0, lines.length - highSignalLines.length);
    const omittedTag =
      omittedCount > 2
        ? `\n  [omitted ${omittedCount} lines of routine output]`
        : '';
    body = `${highSignalLines.map(l => `  > ${l}`).join('\n')}${omittedTag}`;
  } else if (lines.length <= 4 && rawOutput.length <= maxPerToolChars) {
    body = lines.map(l => `  ${l.trim()}`).join('\n');
  } else {
    const firstLine = lines[0]?.trim() ?? '';
    const lastLine = lines.length > 1 ? lines[lines.length - 1]?.trim() ?? '' : '';
    const preview = [firstLine, lastLine].filter(Boolean).join(' ... ');
    body = `  ${truncateHeadTail(preview, 180, ' ... ')}\n  [omitted ${lines.length} lines / ${rawOutput.length} chars of routine output]`;
  }

  return truncateHeadTail(`${header}\n${body}`, maxPerToolChars);
}

/**
 * Compresses large fenced code blocks in assistant responses while preserving prose and metrics.
 */
export function compressAssistantProse(
  rawAssistantText,
  { maxAssistantChars = 2000, maxCodeBlockChars = 400 } = {}
) {
  const cleanText = stripTaskMarker(String(rawAssistantText ?? ''));
  let compressedBlocks = 0;

  const folded = cleanText.replace(FENCED_CODE_BLOCK_REGEX, (fullMatch, lang, codeBody) => {
    if (codeBody.length <= maxCodeBlockChars) {
      return fullMatch;
    }
    compressedBlocks++;
    const lineCount = codeBody.replace(/\r?\n$/, '').split(/\r?\n/).length;
    const langTag = lang ? lang : 'text';
    return `[code block (${langTag}, ${lineCount} lines) omitted]`;
  });

  return {
    text: truncateHeadTail(folded, maxAssistantChars),
    compressed_code_blocks: compressedBlocks
  };
}

/**
 * Deterministically distills a generic turn trajectory `{ turn, user, assistant, tools }`
 * within strict character budgets.
 */
export function distillTurnTrajectory(
  turnInput = {},
  {
    maxTurnChars = 6000,
    maxUserChars = 2000,
    maxToolsTotalChars = 2000,
    maxPerToolChars = 500,
    maxAssistantChars = 2000,
    maxCodeBlockChars = 400
  } = {}
) {
  const userRaw = String(turnInput.user ?? '').trim();
  const assistantRaw = String(turnInput.assistant ?? '').trim();
  const tools = Array.isArray(turnInput.tools) ? turnInput.tools : [];

  const rawChars =
    userRaw.length +
    assistantRaw.length +
    tools.reduce((acc, t) => acc + String(t?.output ?? '').length + String(t?.target ?? '').length, 0);

  const sections = [];

  if (turnInput.turn !== undefined && turnInput.turn !== null) {
    sections.push(`[Turn ${turnInput.turn}]`);
  }

  // Priority 1: User Message
  if (userRaw) {
    sections.push(`User: ${truncateHeadTail(userRaw, maxUserChars)}`);
  }

  // Priority 2: High-Signal Tool Summaries
  if (tools.length > 0) {
    const toolSnippets = tools.map(t => distillToolEvent(t, { maxPerToolChars }));
    const combinedTools = truncateHeadTail(toolSnippets.join('\n'), maxToolsTotalChars);
    sections.push(`Tools (${tools.length}):\n${combinedTools}`);
  }

  // Priority 3: Marker-Stripped Assistant Conclusion
  let compressedCodeBlocks = 0;
  if (assistantRaw) {
    const assistantRes = compressAssistantProse(assistantRaw, {
      maxAssistantChars,
      maxCodeBlockChars
    });
    compressedCodeBlocks = assistantRes.compressed_code_blocks;
    if (assistantRes.text) {
      sections.push(`Assistant: ${assistantRes.text}`);
    }
  }

  const distilledText = truncateHeadTail(sections.join('\n\n'), maxTurnChars);

  return {
    distilled_text: distilledText,
    stats: {
      raw_chars: rawChars,
      distilled_chars: distilledText.length,
      tool_count: tools.length,
      compressed_code_blocks: compressedCodeBlocks
    }
  };
}

/**
 * Distills an array of `.cairn/tasks/<id>/thread.jsonl` records for task compaction.
 */
export function distillTaskThread(
  threadRecords = [],
  {
    maxThreadChars = 12000,
    maxPerRecordChars = 1500,
    maxCodeBlockChars = 300,
    maxPerToolChars = 350
  } = {}
) {
  if (!Array.isArray(threadRecords) || threadRecords.length === 0) {
    return {
      distilled_text: '',
      record_count: 0
    };
  }

  const formattedRecords = threadRecords.map(rec => {
    const role = String(rec.role ?? 'assistant').toLowerCase();
    const seqTag = rec.seq !== undefined ? `#${rec.seq}` : '';
    const turnTag = rec.turn !== undefined ? `turn=${rec.turn}` : '';
    const header = `[${[seqTag, turnTag, role].filter(Boolean).join(' ')}]`;

    let body = '';
    if (role === 'assistant') {
      body = compressAssistantProse(rec.content ?? '', {
        maxAssistantChars: maxPerRecordChars,
        maxCodeBlockChars
      }).text;
    } else {
      body = truncateHeadTail(String(rec.content ?? ''), maxPerRecordChars);
    }

    const metaTools = Array.isArray(rec.meta?.tools) ? rec.meta.tools : [];
    if (metaTools.length > 0) {
      const toolText = metaTools
        .map(t => distillToolEvent(t, { maxPerToolChars }))
        .join('\n');
      body = `${body}\n${toolText}`.trim();
    }

    return `${header} ${body}`;
  });

  return {
    distilled_text: truncateHeadTail(formattedRecords.join('\n\n'), maxThreadChars),
    record_count: threadRecords.length
  };
}
