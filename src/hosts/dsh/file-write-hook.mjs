import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureFileWrite } from '../../kernel/file-writes.mjs';

export function installFileWriteHook(ctx, hub, runtime) {
  return ctx.on('fs/write-intent', async (target, exec, next) => {
    // Let dsh decide permission and write guards. Return its exact intent, never a substitute.
    const policy = await next();
    if (exec?.name !== 'write' || exec.parent || exec.signal?.aborted) return policy;
    const session = exec.agent?.session?.id, entry = runtime.turns.get(session), scope = entry?.scope;
    const call = entry?.writeCalls?.get(exec.callId);
    if (!call || call.step !== entry.step || !scope?.taskId || !scope.projectId || scope.bindingEpoch !== scope.expectedEpoch) return policy;
    const args = exec.arguments, requested = args?.file_path;
    if (typeof requested !== 'string' || typeof args.content !== 'string' || requested.split(/[\\/]/u).includes('..') ||
      /^(?:\\\\|\/\/|[a-z]:(?![\\/]))/iu.test(requested)) return policy;
    const backend = ctx.get?.('fs');
    if (!backend?.processPathFromHostPath || !backend.processPath) return policy;
    const cwd = path.isAbsolute(requested) ? null : await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal);
    if (!path.isAbsolute(requested) && (!cwd || !path.isAbsolute(cwd))) return policy;
    const local = path.resolve(cwd ?? '', requested);
    const mapped = backend.processPathFromHostPath(local);
    if (!mapped || path.relative(mapped, backend.processPath(target)) !== '' || runtime.turns.get(session) !== entry || exec.signal?.aborted) return policy;
    captureFileWrite(hub, { taskId: scope.taskId, projectId: scope.projectId, bindingEpoch: scope.bindingEpoch,
      target: local, sha256: createHash('sha256').update(args.content, 'utf8').digest('hex'),
      source: { host: 'dsh', session_id: session, turn: entry.turn, step: call.step, call_id: exec.callId, journal_seq: call.seq } });
    return policy;
  }, { prepend: true, global: true });
}
