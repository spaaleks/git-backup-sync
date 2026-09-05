import { gitlab } from '../providers/index.js';
import { pushMirror } from '../mirror.js';
import { firstLine } from '../mail/format.js';

export async function pushWithRelax({ dir, destUrl, destGit, mapping, project, destConn, result, rlog }) {
  try {
    await pushMirror(dir, destUrl, destGit, mapping.pushMode);
    return;
  } catch (err) {
    const stderr = String(err.stderr || '');

    if (!isPushRuleRejection(stderr)) {
      err.message += pushHint(stderr);
      throw err;
    }
    if (!mapping.relaxPushRules) {
      err.message += pushHint(stderr);
      throw err;
    }
    if (!project?.id) {
      err.message += '\ncannot relax the push rules: the destination project id is unknown.' + pushHint(stderr);
      throw err;
    }

    if (result.relaxedPushRules?.preemptive) {
      err.message += stillRuleBlocked(stderr) + pushHint(stderr);
      throw err;
    }

    rlog.warn('push rejected by a destination push rule, relaxing it and retrying', {
      project: mapping.path,
      reason: firstLine(stderr.split('remote:').find((l) => /cannot push|declined|committer/i.test(l)) || stderr),
    });

    try {
      result.relaxedPushRules = await gitlab.relaxPushRules(destConn, project.id);
    } catch (apiErr) {
      err.message += `\ncould not relax the destination push rules: ${apiErr.message}` + pushHint(stderr);
      throw err;
    }

    try {
      await pushMirror(dir, destUrl, destGit, mapping.pushMode);
      result.relaxedPushRules.retrySucceeded = true;
      rlog.info('push succeeded after relaxing the destination push rules', { project: mapping.path });
    } catch (retryErr) {
      result.relaxedPushRules.retrySucceeded = false;
      retryErr.message += stillRuleBlocked(String(retryErr.stderr || '')) + pushHint(String(retryErr.stderr || ''));
      throw retryErr;
    }
  }
}

export function stillRuleBlocked(stderr) {
  if (!isPushRuleRejection(stderr)) {
    return '\nthe destination push rules were relaxed on this project, so this failure is not a push rule.';
  }
  return (
    '\nthe push rules were relaxed on the project and it was still rejected by one, so the rule is ' +
    'enforced on the parent group or instance-wide, where a project-level override cannot reach. ' +
    'Turn it off at Group -> Settings -> Repository -> Push rules, or in the Admin area.'
  );
}

export function isPushRuleRejection(stderr) {
  if (!/pre-receive hook declined/i.test(stderr)) return false;
  return /committer email|commit author|You cannot push commits|is not a member|not a verified email/i.test(stderr);
}

export function pushHint(stderr) {
  if (isPushRuleRejection(stderr)) {
    return (
      '\n\nThis is a GitLab push rule, not a problem with the mirror. Commits made through ' +
      "GitHub's web UI are committed as noreply@github.com, and no mirror can satisfy a rule that " +
      'requires every committer email to be verified by the pushing account without rewriting history, ' +
      'which would change every commit SHA. Either set `relax_push_rules: true` on this destination so ' +
      'the service disables the rule on the projects it manages, or turn off "Reject unverified users" ' +
      'under Settings -> Repository -> Push rules on the destination group.'
    );
  }
  if (/No refs in common/i.test(stderr)) {
    return '\n\nThe local mirror has no branches or tags, so the source repository is probably empty.';
  }
  return '';
}
