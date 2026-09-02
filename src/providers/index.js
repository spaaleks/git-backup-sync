import * as github from './github.js';
import * as gitlab from './gitlab.js';
import * as git from './git.js';

const PROVIDERS = { github, gitlab, git };

export function providerFor(connection) {
  const p = PROVIDERS[connection.provider];
  if (!p) throw new Error(`internal: unsupported provider ${connection.provider}`);
  return p;
}

export async function enumerateSource(connection, source) {
  const provider = providerFor(connection);
  const all = await provider.enumerate(connection, source);
  const includes = (source.include || []).map((p) => new RegExp(p));
  const excludes = (source.exclude || []).map((p) => new RegExp(p));

  const repos = [];
  const filtered = [];

  for (const repo of all) {
    const unreadable = unreadableReason(repo);
    if (unreadable) {
      filtered.push({ repo, reason: unreadable, kind: 'unreadable' });
      continue;
    }
    const reason = filterReason(repo, source, includes, excludes);
    if (reason) filtered.push({ repo, reason, kind: 'filter' });
    else repos.push(repo);
  }

  repos.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  return { repos, filtered };
}

function unreadableReason(repo) {
  if (repo.repositoryEnabled === false) {
    return 'the repository feature is disabled on the source, so there is no code to clone';
  }
  if (typeof repo.accessLevel === 'number' && repo.accessLevel < 20) {
    return `the token has access level ${repo.accessLevel} on the source, below Reporter (20), which cannot download code`;
  }
  return null;
}

function filterReason(repo, source, includes, excludes) {
  if (includes.length && !includes.some((re) => re.test(repo.fullPath))) {
    return 'no `include` pattern matched';
  }
  const hit = excludes.find((re) => re.test(repo.fullPath));
  if (hit) return `matched \`exclude\` pattern /${hit.source}/`;
  if (repo.isFork && !source.include_forks) return 'is a fork and include_forks is false';
  if (repo.isArchived && !source.include_archived) return 'is archived and include_archived is false';
  return null;
}

export { github, gitlab, git };
