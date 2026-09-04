import { ApiError } from '../connections.js';

export function normalize(repo, { source, connection, sourceRoot }) {
  const sshUrl = repo.ssh_url || connection.sshUrl(repo.full_name);
  return {
    source,
    provider: 'github',
    host: hostOf(sshUrl, connection),
    fullPath: repo.full_name,
    owner: repo.owner?.login ?? repo.full_name.split('/')[0],
    repo: repo.name,
    relativePath: '',
    sourceRoot,
    defaultBranch: repo.default_branch || null,
    sshUrl,
    isFork: Boolean(repo.fork),
    isArchived: Boolean(repo.archived),
    sizeHint: typeof repo.size === 'number' ? repo.size * 1024 : null,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    hasWiki: Boolean(repo.has_wiki),
    description: repo.description ?? '',
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    wikiSshUrl: sshUrl.replace(/\.git$/, '.wiki.git'),
    empty: repo.size === 0 && !repo.default_branch,
    repositoryEnabled: repo.disabled !== true && repo.permissions?.pull !== false,
    accessLevel: null,
  };
}

function hostOf(sshUrl, connection) {
  const m = String(sshUrl).match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)/);
  return m ? m[1] : connection.host;
}

export async function whoami(connection) {
  const { data } = await connection.request('/user');
  return { login: data.login, id: data.id, name: data.name, kind: 'user' };
}

export async function enumerate(connection, source) {
  const { scope } = source;
  const ctx = { source: source.name, connection };

  if (scope.type === 'projects' || scope.type === 'repos') {
    const paths = scope.projects || scope.repos || [];
    const out = [];
    for (const path of paths) {
      const { data, status } = await connection.request(`/repos/${path}`, { expect404: true });
      if (status === 404) {
        throw new ApiError(`repository "${path}" listed in sources.${source.name}.scope.projects was not found`);
      }
      out.push(normalize(data, { ...ctx, sourceRoot: path.split('/')[0] }));
    }
    return out;
  }

  if (scope.type === 'self') {
    const repos = await connection.paginate(
      '/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=full_name',
    );
    return repos.map((r) => normalize(r, { ...ctx, sourceRoot: r.owner?.login }));
  }

  if (scope.type === 'org') {
    const repos = await connection.paginate(`/orgs/${encodeURIComponent(scope.login)}/repos?type=all&sort=full_name`);
    return repos.map((r) => normalize(r, { ...ctx, sourceRoot: scope.login }));
  }

  const me = await whoami(connection);
  if (me.login.toLowerCase() === scope.login.toLowerCase()) {
    const repos = await connection.paginate('/user/repos?affiliation=owner&visibility=all&sort=full_name');
    return repos.map((r) => normalize(r, { ...ctx, sourceRoot: scope.login }));
  }

  connection.log.warn('enumerating another user, only public repositories are visible', {
    source: source.name,
    login: scope.login,
    token_owner: me.login,
  });
  const repos = await connection.paginate(`/users/${encodeURIComponent(scope.login)}/repos?type=owner&sort=full_name`);
  return repos.map((r) => normalize(r, { ...ctx, sourceRoot: scope.login }));
}

export async function getRepo(connection, fullPath) {
  const { data, status } = await connection.request(`/repos/${fullPath}`, { expect404: true });
  return status === 404 ? null : data;
}

export async function getOwner(connection, login) {
  const me = await whoami(connection);
  if (me.login.toLowerCase() === login.toLowerCase()) return { kind: 'user', login: me.login, self: true };

  const { data, status } = await connection.request(`/orgs/${encodeURIComponent(login)}`, { expect404: true });
  if (status !== 404) return { kind: 'org', login: data.login, self: false };

  const user = await connection.request(`/users/${encodeURIComponent(login)}`, { expect404: true });
  if (user.status !== 404) return { kind: 'user', login: user.data.login, self: false };
  return null;
}

export async function createRepo(connection, { owner, ownerKind, name, description, isPrivate }) {
  const path = ownerKind === 'org' ? `/orgs/${encodeURIComponent(owner)}/repos` : '/user/repos';
  const { data } = await connection.request(path, {
    method: 'POST',
    body: { name, description: description || '', private: isPrivate, auto_init: false, has_wiki: false },
  });
  return data;
}

export async function updateRepo(connection, fullPath, body) {
  const { data } = await connection.request(`/repos/${fullPath}`, { method: 'PATCH', body });
  return data;
}

export async function setTopics(connection, fullPath, topics) {
  await connection.request(`/repos/${fullPath}/topics`, {
    method: 'PUT',
    body: { names: topics },
    headers: { Accept: 'application/vnd.github+json' },
  });
}

export async function actionsEnabled(connection, fullPath) {
  const { data, status } = await connection.request(`/repos/${fullPath}/actions/permissions`, { expect404: true });
  return status === 404 ? false : data.enabled !== false;
}

export async function disableActions(connection, fullPath) {
  await connection.request(`/repos/${fullPath}/actions/permissions`, { method: 'PUT', body: { enabled: false } });
}

export async function deleteRepo(connection, fullPath) {
  await connection.request(`/repos/${fullPath}`, { method: 'DELETE' });
}

export function metadataDiff(repoOnDestination, source, pushedRefs) {
  const changes = {};
  const description = source.description ?? '';
  if ((repoOnDestination.description ?? '') !== description) changes.description = description;

  if (source.defaultBranch && repoOnDestination.default_branch !== source.defaultBranch) {
    if (!pushedRefs || pushedRefs.has(`refs/heads/${source.defaultBranch}`)) {
      changes.default_branch = source.defaultBranch;
    }
  }
  return changes;
}

export function topicsDiffer(repoOnDestination, source) {
  const theirs = [...(repoOnDestination.topics ?? [])].sort();
  const ours = [...(source.topics ?? [])].sort().map((t) => t.toLowerCase());
  return theirs.join('\u0000') !== ours.join('\u0000');
}
