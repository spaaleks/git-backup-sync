export async function whoami() {
  return { login: null, kind: 'anonymous' };
}

export function parseGitUrl(url) {
  const text = String(url).trim();

  let match = text.match(/^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/);
  if (match) return { host: match[2], fullPath: match[4], scheme: 'ssh' };

  match = text.match(/^(?:([^@]+)@)([^:]+):(.+?)(?:\.git)?\/?$/);
  if (match) return { host: match[2], fullPath: match[3], scheme: 'scp' };

  match = text.match(/^(https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (match) return { host: match[2], fullPath: match[3], scheme: match[1] };

  if (text.startsWith('/') || text.startsWith('.')) {
    const clean = text.replace(/\.git\/?$/, '');
    return { host: 'localhost', fullPath: clean.replace(/^\/+/, ''), scheme: 'file' };
  }

  return null;
}

function normalize(entry, { source, connection }) {
  const parsed = parseGitUrl(entry.url);
  if (!parsed) throw new Error(`"${entry.url}" is not a git URL this service recognises`);

  const fullPath = entry.name ?? parsed.fullPath;
  const segments = fullPath.split('/').filter(Boolean);
  const repo = segments.at(-1);

  return {
    source,
    provider: 'git',
    host: parsed.host,
    fullPath,
    owner: segments.length > 1 ? segments.at(-2) : parsed.host,
    repo,
    relativePath: segments.slice(0, -1).join('/'),
    sourceRoot: null,
    defaultBranch: null,
    sshUrl: entry.url,
    wikiSshUrl: entry.url.replace(/\.git$/, '') + '.wiki.git',
    isFork: false,
    isArchived: false,
    sizeHint: null,
    visibility: 'private',
    hasWiki: false,
    empty: false,
    repositoryEnabled: true,
    accessLevel: null,
    description: '',
    topics: [],
    explicitDestination: entry.destination ?? null,
    connectionName: connection?.name ?? null,
  };
}

export async function enumerate(connection, source) {
  const entries = (source.scope.urls ?? []).map((u) => (typeof u === 'string' ? { url: u } : u));

  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const repo = normalize(entry, { source: source.name, connection });
    const key = `${repo.host}/${repo.fullPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}
