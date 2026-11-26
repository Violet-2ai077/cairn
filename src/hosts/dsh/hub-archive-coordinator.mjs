import { archiveHubTurn, finishArchiveJob, listArchiveJobs, readHubTasksIndex, readHubTaskThread,
  readTurnReceipts, recordTurnReceipt, settleExtraction } from '../../kernel/hub-store.mjs';
import { openMemoryReview, prepareMemoryReview } from '../../kernel/memory-review.mjs';
import { explicitUserDefaults } from '../../workers/hub-auto-commit.mjs';
import { draftPreference, splitMemoryIntent } from '../../workers/memory-intent.mjs';
import { runHubStagingExtractor } from '../../workers/hub-staging-extractor.mjs';

export function createArchiveCoordinator({ hubRoot, config, clientFor, compactionCoordinator, workerLlmCallContext }) {
  const pending = new Set();
  const sessionJobs = new Map();
  const archiveRecoveryIssues = [];
  function report(issue) {
    if (archiveRecoveryIssues.length === 100) archiveRecoveryIssues.shift();
    archiveRecoveryIssues.push(issue);
  }
  function enqueueSessionJob(sessionId, job, failed) {
    const previous = sessionJobs.get(sessionId) ?? Promise.resolve();
    const next = previous.then(job).catch(failed);
    sessionJobs.set(sessionId, next); pending.add(next);
    next.finally(() => { pending.delete(next); if (sessionJobs.get(sessionId) === next) sessionJobs.delete(sessionId); });
    return next;
  }
  const scheduled = new Set();
  function queueArchived(job) {
    const { sessionId, taskId, projectId, project, turn, sourceStep, user, assistant, authoredUser, route } = job;
    const client = clientFor(route);
    const key = JSON.stringify([sessionId, turn]);
    if (scheduled.has(key)) return;
    scheduled.add(key);
    enqueueSessionJob(sessionId, async () => {
      const plan = job.midSession ? splitMemoryIntent(authoredUser, projectId) : null;
      const scopes = plan?.filtered ? (plan.remaining ? [{ scope: projectId ? 'project' : 'user', projectId, user: plan.remaining, assistant: '' }] : [])
        : [{ scope: projectId ? 'project' : 'user', projectId, user, assistant }];
      if (plan?.filtered) recordTurnReceipt(hubRoot, sessionId, turn, {
        memory_review_ids: plan.cards.map((_, i) => turn + '.' + (i + 1)),
      });
      for (const [i, card] of (plan?.cards ?? []).entries()) {
        const id = turn + '.' + (i + 1);
        const row = openMemoryReview(hubRoot, sessionId, id, card, projectId);
        if (row.status !== 'preparing') continue;
        let op = null, failure = 'no_proposal';
        try { op = await workerLlmCallContext.run({ sessionId }, () => draftPreference(client, card)); }
        catch { failure = 'worker_failed'; }
        prepareMemoryReview(hubRoot, sessionId, id, op, failure);
      }
      if (plan?.filtered && !scopes.length) recordTurnReceipt(hubRoot, sessionId, turn, {
        extraction: { [projectId ? 'project' : 'user']: plan.cards.length ? 'memory_review' : 'no_ops' }
      });
      const defaults = !job.midSession && projectId && explicitUserDefaults(authoredUser);
      if (defaults) scopes.push({ scope: 'user', projectId: null, user: defaults, assistant: '' });
      for (const input of scopes) {
        const prior = readTurnReceipts(hubRoot, sessionId, turn).extraction[input.scope];
        if (prior && prior !== 'pending') continue;
        if (!prior) recordTurnReceipt(hubRoot, sessionId, turn, { extraction: { [input.scope]: 'pending' } });
        let outcome;
        try {
          const result = await workerLlmCallContext.run({ sessionId }, () => runHubStagingExtractor({
            hubRoot, scope: input.scope, projectId: input.projectId, project,
            turnInput: { turn, user: input.user, assistant: input.assistant },
            authoredUserText: plan?.filtered ? input.user : authoredUser, autopilot: config.autopilot, source_step: sourceStep,
            actor_id: config.actorId ?? 'dsh-host', llmClient: client, extraction: { sessionId, turn }
          }));
          outcome = result.ok ? result.autoCommit?.status ?? (result.staged ? 'staged' : 'no_ops')
            : ['strict_json_parse_failed', 'missing_ops_array', 'all_ops_rejected'].includes(result.error_code) ? result.error_code : 'worker_failed';
        } catch { outcome = 'worker_failed'; }
        settleExtraction(hubRoot, { sessionId, turn, scope: input.scope, projectId: input.projectId, outcome });
      }
      finishArchiveJob(hubRoot, job);
      const current = readHubTasksIndex(hubRoot).tasks.find(item => item.id === taskId);
      if (!current || current.status !== 'active') return;
      const records = readHubTaskThread(hubRoot, taskId).slice(current.compacted_record_count);
      const chars = records.reduce((sum, record) => sum + String(record.content ?? '').length, 0);
      const minRecords = Number.isSafeInteger(config.autoCompactMinRecords) ? config.autoCompactMinRecords : 12;
      const minChars = Number.isSafeInteger(config.autoCompactMinChars) ? config.autoCompactMinChars : 4500;
      if ((minRecords > 0 && records.length >= minRecords) || (minChars > 0 && chars >= minChars)) {
        await workerLlmCallContext.run({ sessionId }, () => compactionCoordinator.run({ taskId, source: 'auto', mode: 'incremental', llmClient: client }));
      }
    }, () => report({ task_id: taskId, turn, code: 'archive_worker_blocked' })).finally(() => scheduled.delete(key));
  }
  for (const job of listArchiveJobs(hubRoot, report)) {
    try {
      const recovered = archiveHubTurn(hubRoot, job);
      if (recovered.job) queueArchived(recovered.job);
      else finishArchiveJob(hubRoot, job);
    } catch {
      report({ task_id: job.taskId, turn: job.turn, code: 'archive_replay_blocked' });
    }
  }
  return { pending, sessionJobs, queueArchived, archiveRecoveryIssues };
}
