import { createServer } from 'node:http';

export async function startFakeApi(fixture) {
  const state = {
    users: fixture.users ?? {},
    groups: structuredClone(fixture.groups ?? {}),
    projects: structuredClone(fixture.projects ?? {}),
    ghRepos: structuredClone(fixture.ghRepos ?? {}),
    ghOrgs: fixture.ghOrgs ?? [],
    ghUsers: fixture.ghUsers ?? [],
    created: { groups: [], projects: [] },
    updated: [],
    tokenOwner: fixture.tokenOwner ?? 'userA',
  };

  let nextId = 1000;

  const hooks = {};

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const body = await readBody(req);
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data ?? null));
    };

    if (p === '/gh/user') return send(200, { login: state.tokenOwner, id: 1 });
    if (p.startsWith('/gh/orgs/') && p.endsWith('/repos') && req.method === 'GET') {
      const org = p.split('/')[3];
      return send(200, Object.values(state.ghRepos).filter((r) => r.full_name.startsWith(`${org}/`)));
    }
    if (p === '/gh/user/repos' && req.method === 'GET') {
      return send(200, Object.values(state.ghRepos).filter((r) => r.full_name.startsWith(`${state.tokenOwner}/`)));
    }
    if ((p === '/gh/user/repos' || /^\/gh\/orgs\/[^/]+\/repos$/.test(p)) && req.method === 'POST') {
      const owner = p === '/gh/user/repos' ? state.tokenOwner : p.split('/')[3];
      const full = `${owner}/${body.name}`;
      const repo = {
        id: ++nextId,
        name: body.name,
        full_name: full,
        owner: { login: owner },
        private: body.private !== false,
        description: body.description ?? '',
        topics: [],
        default_branch: null,
        archived: false,
        ssh_url: `git@github.com:${full}.git`,
      };
      state.ghRepos[full] = repo;
      state.created.projects.push(full);
      await hooks.onCreateProject?.(full);
      return send(201, repo);
    }
    if (/^\/gh\/orgs\/[^/]+$/.test(p)) {
      const org = p.split('/')[3];
      if (!(state.ghOrgs ?? []).includes(org)) return send(404, { message: 'Not Found' });
      return send(200, { login: org });
    }
    if (/^\/gh\/users\/[^/]+$/.test(p)) {
      const login = p.split('/')[3];
      if (login !== state.tokenOwner && !(state.ghUsers ?? []).includes(login)) return send(404, { message: 'Not Found' });
      return send(200, { login });
    }
    if (/^\/gh\/repos\/[^/]+\/[^/]+\/actions\/permissions$/.test(p)) {
      const full = p.split('/').slice(3, 5).join('/');
      const repo = state.ghRepos[full];
      if (!repo) return send(404, { message: 'Not Found' });
      if (req.method === 'PUT') {
        repo.actions_enabled = body.enabled;
        state.updated.push({ project: full, body });
        return send(204, null);
      }
      return send(200, { enabled: repo.actions_enabled !== false });
    }
    if (/^\/gh\/repos\/[^/]+\/[^/]+\/topics$/.test(p)) {
      const full = p.split('/').slice(3, 5).join('/');
      const repo = state.ghRepos[full];
      if (!repo) return send(404, { message: 'Not Found' });
      repo.topics = body.names ?? [];
      state.updated.push({ project: full, body: { topics: repo.topics } });
      return send(200, { names: repo.topics });
    }
    if (/^\/gh\/repos\/[^/]+\/[^/]+$/.test(p)) {
      const full = p.split('/').slice(3, 5).join('/');
      const repo = state.ghRepos[full];
      if (!repo) return send(404, { message: 'Not Found' });
      if (req.method === 'PATCH') {
        Object.assign(repo, body);
        state.updated.push({ project: full, body });
      }
      if (req.method === 'DELETE') {
        delete state.ghRepos[full];
        return send(204, null);
      }
      return send(200, repo);
    }

    if (p === '/gl/user') return send(200, { username: state.tokenOwner, id: 1 });
    if (p === '/gl/personal_access_tokens/self') return send(404, { message: 'not found' });

    if (p === '/gl/users') {
      const username = url.searchParams.get('username');
      return send(200, username === state.tokenOwner ? [{ id: 1, username }] : []);
    }
    if (/^\/gl\/users\/\d+\/projects$/.test(p)) {
      const owner = state.tokenOwner;
      return send(200, Object.values(state.projects).filter((x) => x.path_with_namespace.split('/')[0] === owner && x.path_with_namespace.split('/').length === 2));
    }
    if (p === '/gl/groups' && req.method === 'POST') {
      const parent = Object.values(state.groups).find((g) => g.id === body.parent_id);
      const fullPath = parent ? `${parent.full_path}/${body.path}` : body.path;
      const group = { id: ++nextId, full_path: fullPath, name: body.name, permissions: { group_access: { access_level: 50 } } };
      state.groups[fullPath] = group;
      state.created.groups.push(fullPath);
      return send(201, group);
    }
    if (p === '/gl/groups') {
      return send(200, Object.values(state.groups).filter((g) => g.owned !== false));
    }
    if (/^\/gl\/groups\/[^/]+\/projects$/.test(p)) {
      const ref = decodeURIComponent(p.split('/')[3]);
      const group = state.groups[ref] ?? Object.values(state.groups).find((g) => String(g.id) === ref);
      if (!group) return send(404, { message: '404 Group Not Found' });
      const recursive = url.searchParams.get('include_subgroups') !== 'false';
      return send(
        200,
        Object.values(state.projects).filter((x) =>
          recursive
            ? x.path_with_namespace.startsWith(`${group.full_path}/`)
            : x.path_with_namespace.replace(/\/[^/]+$/, '') === group.full_path,
        ),
      );
    }
    if (/^\/gl\/namespaces\/[^/]+$/.test(p)) {
      const ref = decodeURIComponent(p.split('/')[3]);
      const group = state.groups[ref];
      if (group) return send(200, { id: group.id, kind: 'group', full_path: group.full_path, name: group.name });
      const user = state.users[ref];
      if (user) return send(200, { id: user.id, kind: 'user', full_path: ref, name: ref });
      return send(404, { message: '404 Namespace Not Found' });
    }
    if (/^\/gl\/groups\/[^/]+$/.test(p)) {
      const ref = decodeURIComponent(p.split('/')[3]);
      const group = state.groups[ref] ?? Object.values(state.groups).find((g) => String(g.id) === ref);
      if (!group) return send(404, { message: '404 Group Not Found' });
      return send(200, { permissions: { group_access: { access_level: 50 } }, ...group });
    }
    if (p === '/gl/projects' && req.method === 'POST') {
      const parent = Object.values(state.groups).find((g) => g.id === body.namespace_id);
      if (!parent) return send(400, { message: `namespace_id ${body.namespace_id} does not exist` });
      const fullPath = `${parent.full_path}/${body.path}`;
      const project = {
        id: ++nextId,
        path: body.path,
        path_with_namespace: fullPath,
        visibility: body.visibility,
        builds_access_level: body.builds_access_level ?? 'enabled',
        auto_devops_enabled: body.auto_devops_enabled ?? false,
      };
      state.projects[fullPath] = project;
      state.created.projects.push(fullPath);
      await hooks.onCreateProject?.(fullPath);
      return send(201, project);
    }
    if (/^\/gl\/projects\/[^/]+$/.test(p)) {
      const ref = decodeURIComponent(p.split('/')[3]);
      const project = state.projects[ref] ?? Object.values(state.projects).find((x) => String(x.id) === ref);
      if (!project) return send(404, { message: '404 Project Not Found' });
      if (req.method === 'PUT') {
        Object.assign(project, body);
        state.updated.push({ project: project.path_with_namespace, body });
      }
      return send(200, project);
    }

    return send(404, { message: `no fake route for ${req.method} ${p}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    hooks,
    ghUrl: `http://127.0.0.1:${port}/gh`,
    glUrl: `http://127.0.0.1:${port}/gl`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function glProject(fullPath, over = {}) {
  const path = fullPath.split('/').at(-1);
  return {
    id: Math.abs(hash(fullPath)),
    path,
    path_with_namespace: fullPath,
    default_branch: 'main',
    ssh_url_to_repo: `git@gitlab.example.com:${fullPath}.git`,
    visibility: 'private',
    archived: false,
    ...over,
  };
}

export function ghRepo(fullName, over = {}) {
  const [owner, name] = fullName.split('/');
  return {
    id: Math.abs(hash(fullName)),
    name,
    full_name: fullName,
    owner: { login: owner },
    default_branch: 'main',
    ssh_url: `git@github.com:${fullName}.git`,
    private: true,
    fork: false,
    archived: false,
    size: 100,
    has_wiki: false,
    ...over,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
