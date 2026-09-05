import { ApiError } from '../connections.js';

const enc = encodeURIComponent;

export function normalize(project, { source, connection, sourceRoot }) {
  const fullPath = project.path_with_namespace;
  const namespacePath = fullPath.slice(0, fullPath.length - project.path.length - 1);
  return {
    source,
    provider: 'gitlab',
    host: hostOf(project.ssh_url_to_repo, connection),
    fullPath,
    owner: namespacePath.split('/').at(-1) || namespacePath,
    repo: project.path,
    relativePath: relativeTo(namespacePath, sourceRoot),
    sourceRoot,
    defaultBranch: project.default_branch || null,
    sshUrl: project.ssh_url_to_repo || connection.sshUrl(fullPath),
    isFork: Boolean(project.forked_from_project),
    isArchived: Boolean(project.archived),
    sizeHint: project.statistics?.repository_size ?? null,
    visibility: project.visibility || 'private',
    hasWiki: project.wiki_access_level ? project.wiki_access_level !== 'disabled' : Boolean(project.wiki_enabled),
    description: project.description ?? '',
    topics: Array.isArray(project.topics) ? project.topics : [],
    wikiSshUrl: (project.ssh_url_to_repo || connection.sshUrl(fullPath)).replace(/\.git$/, '.wiki.git'),
    empty: Boolean(project.empty_repo),
    repositoryEnabled: project.repository_access_level !== 'disabled',
    accessLevel:
      project.permissions?.project_access?.access_level ??
      project.permissions?.group_access?.access_level ??
      null,
    projectId: project.id,
  };
}

function relativeTo(namespacePath, sourceRoot) {
  if (!sourceRoot) return namespacePath;
  if (namespacePath === sourceRoot) return '';
  if (namespacePath.startsWith(`${sourceRoot}/`)) return namespacePath.slice(sourceRoot.length + 1);
  return namespacePath;
}

function hostOf(sshUrl, connection) {
  if (!sshUrl) return connection.host;
  const m = String(sshUrl).match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)/);
  return m ? m[1] : connection.host;
}

export async function whoami(connection) {
  const { data } = await connection.request('/user');
  return {
    login: data.username,
    id: data.id,
    name: data.name,
    kind: 'user',
    canCreateGroup: data.can_create_group !== false,
  };
}

const PROJECT_QUERY = 'archived=false&simple=false&order_by=path&sort=asc';

export async function enumerate(connection, source) {
  const { scope } = source;
  const ctx = { source: source.name, connection };
  const byId = new Map();
  const add = (project, sourceRoot) => {
    if (!byId.has(project.id)) byId.set(project.id, normalize(project, { ...ctx, sourceRoot }));
  };

  if (scope.type === 'projects' || scope.type === 'repos') {
    const paths = scope.projects || scope.repos || [];
    for (const path of paths) {
      const { data, status } = await connection.request(`/projects/${enc(path)}?statistics=true`, { expect404: true });
      if (status === 404) {
        throw new ApiError(`project "${path}" listed in sources.${source.name}.scope.projects was not found`);
      }
      add(data, data.path_with_namespace.split('/')[0]);
    }
    return [...byId.values()];
  }

  if (scope.type === 'self') {
    const projects = await connection.paginate(`/projects?membership=true&${PROJECT_QUERY}`);
    for (const p of projects) add(p, p.path_with_namespace.split('/')[0]);
    return [...byId.values()];
  }

  if (scope.type === 'group') {
    const recursive = scope.recursive !== false;
    const projects = await connection.paginate(
      `/groups/${enc(scope.login)}/projects?include_subgroups=${recursive}&${PROJECT_QUERY}`,
    );
    for (const p of projects) add(p, scope.login);
    return [...byId.values()];
  }

  const me = await whoami(connection);
  const isSelf = me.login.toLowerCase() === scope.login.toLowerCase();

  let userId = me.id;
  if (!isSelf) {
    const { data } = await connection.request(`/users?username=${enc(scope.login)}`);
    if (!Array.isArray(data) || data.length === 0) {
      throw new ApiError(`no GitLab user "${scope.login}" on ${connection.host}`);
    }
    userId = data[0].id;
  }

  const personal = await connection.paginate(`/users/${userId}/projects?${PROJECT_QUERY}`);
  for (const p of personal) add(p, scope.login);

  if (scope.include_owned_groups) {
    if (!isSelf) {
      connection.log.warn('include_owned_groups reflects the token owner, not the named user', {
        source: source.name,
        login: scope.login,
        token_owner: me.login,
      });
    }
    const groups = await listGroups(connection, { membership: scope.include_membership });
    for (const group of rootsOf(groups)) {
      const projects = await connection.paginate(
        `/groups/${group.id}/projects?include_subgroups=true&${PROJECT_QUERY}`,
      );
      for (const p of projects) add(p, scope.login);
    }
  }

  return [...byId.values()];
}

async function listGroups(connection, { membership }) {
  const query = membership ? 'min_access_level=10' : 'owned=true';
  return connection.paginate(`/groups?${query}&all_available=false&order_by=path&sort=asc`);
}

function rootsOf(groups) {
  const paths = new Set(groups.map((g) => g.full_path));
  return groups.filter((g) => {
    const segments = g.full_path.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (paths.has(segments.slice(0, i).join('/'))) return false;
    }
    return true;
  });
}

export async function getNamespace(connection, fullPath) {
  const { data, status } = await connection.request(`/namespaces/${enc(fullPath)}`, { expect404: true });
  if (status === 404) return null;
  return { id: data.id, kind: data.kind, fullPath: data.full_path, name: data.name };
}

export async function getGroup(connection, fullPath) {
  const { data, status } = await connection.request(`/groups/${enc(fullPath)}?with_projects=false`, {
    expect404: true,
  });
  if (status === 404) return null;
  return { id: data.id, fullPath: data.full_path, name: data.name, visibility: data.visibility };
}

export async function createGroup(connection, { name, path, parentId, visibility }) {
  const { data } = await connection.request('/groups', {
    method: 'POST',
    body: { name, path, visibility, ...(parentId ? { parent_id: parentId } : {}) },
  });
  return { id: data.id, fullPath: data.full_path, name: data.name };
}

// A project marked for deletion is renamed to <path>-deletion_scheduled-<id> and
// leaves a redirect route behind, so the API answers for the old path with the
// doomed project. Pushing into it is refused, so the old path counts as free.
export async function getProject(connection, fullPath, { followRedirect = false } = {}) {
  const { data, status } = await connection.request(`/projects/${enc(fullPath)}?statistics=true`, { expect404: true });
  if (status === 404) return null;
  if (!followRedirect && !samePath(data?.path_with_namespace, fullPath)) return null;
  return data;
}

function samePath(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

export function markedForDeletion(project) {
  return Boolean(project?.marked_for_deletion_at || project?.marked_for_deletion_on);
}

export async function createProject(connection, { name, path, namespaceId, visibility, disableCi }) {
  const { data } = await connection.request('/projects', {
    method: 'POST',
    body: {
      name,
      path,
      namespace_id: namespaceId,
      visibility,
      initialize_with_readme: false,
      lfs_enabled: true,
      ...(disableCi ? CI_DISABLED : {}),
    },
  });
  return data;
}

const CI_DISABLED = { builds_access_level: 'disabled', auto_devops_enabled: false };

export function ciEnabled(project) {
  if (!project) return false;
  const builds = project.builds_access_level ?? (project.jobs_enabled === false ? 'disabled' : 'enabled');
  return builds !== 'disabled' || project.auto_devops_enabled === true;
}

const VISIBILITY_RANK = { private: 0, internal: 1, public: 2 };

export function isMoreRestrictive(target, current) {
  return (VISIBILITY_RANK[target] ?? 0) < (VISIBILITY_RANK[current] ?? 0);
}

export async function setVisibility(connection, projectId, visibility) {
  const { data } = await connection.request(`/projects/${projectId}`, { method: 'PUT', body: { visibility } });
  return data;
}

export async function disableCi(connection, projectId) {
  const { data } = await connection.request(`/projects/${projectId}`, { method: 'PUT', body: CI_DISABLED });
  return data;
}

export async function updateProject(connection, projectId, body) {
  const { data } = await connection.request(`/projects/${projectId}`, { method: 'PUT', body });
  return data;
}

export function metadataDiff(project, repo, pushedRefs) {
  const changes = {};
  const description = repo.description ?? '';
  if ((project.description ?? '') !== description) changes.description = description;

  const theirs = [...(project.topics ?? [])].sort();
  const ours = [...(repo.topics ?? [])].sort();
  if (theirs.join('\u0000') !== ours.join('\u0000')) changes.topics = repo.topics ?? [];

  if (repo.defaultBranch && project.default_branch !== repo.defaultBranch) {
    if (!pushedRefs || pushedRefs.has(`refs/heads/${repo.defaultBranch}`)) {
      changes.default_branch = repo.defaultBranch;
    }
  }
  return changes;
}

export async function enableWiki(connection, projectId) {
  await connection.request(`/projects/${projectId}`, {
    method: 'PUT',
    body: { wiki_access_level: 'enabled' },
  });
}

const PERMISSIVE_PUSH_RULE = {
  commit_committer_check: false,
  commit_committer_name_check: false,
  member_check: false,
  reject_unsigned_commits: false,
  reject_non_dco_commits: false,
  author_email_regex: '',
};

export async function relaxGroupPushRules(connection, groupId) {
  try {
    const existing = await connection.request(`/groups/${groupId}/push_rule`, { expect404: true, retries: 1 });
    const method = existing.status === 404 || !existing.data ? 'POST' : 'PUT';
    const { data } = await connection.request(`/groups/${groupId}/push_rule`, {
      method,
      body: PERMISSIVE_PUSH_RULE,
      retries: 1,
    });
    return { applied: true, before: pickRules(existing.data), after: pickRules(data) };
  } catch (err) {
    return { applied: false, reason: err.message };
  }
}

export async function getPushRule(connection, projectId) {
  const { data, status } = await connection.request(`/projects/${projectId}/push_rule`, { expect404: true });
  return status === 404 ? null : data;
}

export async function relaxPushRules(connection, projectId) {
  const existing = await getPushRule(connection, projectId).catch(() => null);
  const method = existing ? 'PUT' : 'POST';
  const { data } = await connection.request(`/projects/${projectId}/push_rule`, {
    method,
    body: PERMISSIVE_PUSH_RULE,
  });
  return {
    created: !existing,
    before: existing ? pickRules(existing) : null,
    after: pickRules(data),
  };
}

function pickRules(rule) {
  const out = {};
  for (const key of Object.keys(PERMISSIVE_PUSH_RULE)) {
    if (rule?.[key] !== undefined && rule[key] !== false && rule[key] !== '') out[key] = rule[key];
  }
  return out;
}

export async function archiveProject(connection, projectId) {
  await connection.request(`/projects/${projectId}/archive`, { method: 'POST' });
}

export async function deleteProject(connection, projectId, { permanently = false, fullPath } = {}) {
  // Purging needs the current path as proof, and only works once the project is
  // already marked for deletion.
  const query = permanently ? `?permanently_remove=true&full_path=${encodeURIComponent(fullPath)}` : '';
  await connection.request(`/projects/${projectId}${query}`, { method: 'DELETE' });
}

export async function canWriteNamespace(connection, namespace) {
  if (namespace.kind === 'user') {
    const me = await whoami(connection);
    return {
      ok: me.login.toLowerCase() === namespace.fullPath.toLowerCase(),
      reason:
        me.login.toLowerCase() === namespace.fullPath.toLowerCase()
          ? null
          : `the destination token belongs to "${me.login}", but the destination namespace is the personal namespace of "${namespace.fullPath}". ` +
            'Writing into another user\'s namespace requires that user\'s own token (or an admin/impersonation token).',
      tokenOwner: me.login,
    };
  }
  const { data, status } = await connection.request(`/groups/${namespace.id}`, { expect404: true });
  if (status === 404) return { ok: false, reason: `group "${namespace.fullPath}" is not visible to this token` };
  const level = data.permissions?.group_access?.access_level ?? null;
  if (level === null) {
    return { ok: true, reason: null, level: null, unverified: true };
  }
  return {
    ok: level >= 40,
    level,
    reason: level >= 40 ? null : `the destination token has access level ${level} on "${namespace.fullPath}"; 40 (Maintainer) is needed to create projects and subgroups`,
  };
}
