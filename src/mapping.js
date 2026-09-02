export const TEMPLATE_PLACEHOLDERS = [
  'repo',
  'owner',
  'group_path',
  'full_path',
  'source',
  'provider',
  'host',
];

export function slugifySegment(input) {
  let s = String(input)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (s === '') s = 'repo';
  if (!/^[A-Za-z0-9_]/.test(s)) s = `r${s}`;
  return s;
}

const FORBIDDEN_SUFFIX = /\.(git|atom)$/i;

export function validatePath(path) {
  if (!path) return 'resolved to an empty path';
  if (path.startsWith('-') || path.endsWith('-')) return `"${path}" starts or ends with a dash`;
  if (path.includes('..')) return `"${path}" contains ".."`;
  if (FORBIDDEN_SUFFIX.test(path)) return `"${path}" ends in .git or .atom, which GitLab reserves`;
  for (const segment of path.split('/')) {
    if (segment === '') return `"${path}" contains an empty path segment`;
    if (FORBIDDEN_SUFFIX.test(segment)) return `segment "${segment}" ends in .git or .atom`;
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment)) return `segment "${segment}" is not a valid GitLab path`;
  }
  return null;
}

export function renderTemplate(template, repo) {
  const values = {
    repo: repo.repo,
    owner: repo.owner || '',
    group_path: repo.relativePath || '',
    full_path: repo.fullPath,
    source: repo.source,
    provider: repo.provider,
    host: repo.host,
  };
  return template.replace(/\{([a-z_]+)\}/g, (_, key) => (key in values ? values[key] : `{${key}}`));
}

function firstMatchingRule(rules, fullPath) {
  for (const [index, rule] of rules.entries()) {
    if (new RegExp(rule.match).test(fullPath)) return { rule, index };
  }
  return { rule: null, index: -1 };
}

export function resolveMapping(repo, source) {
  const dest = source.destination;
  const explain = {
    repo: repo.fullPath,
    source: source.name,
    connection: source.connection,
    relativePath: repo.relativePath || '(none)',
    steps: [],
  };

  const { rule, index } = firstMatchingRule(source.rules || [], repo.fullPath);
  if (rule) {
    explain.rule = { index, match: rule.match, ...rule };
    explain.steps.push(`rule[${index}] matched "${rule.match}"`);
  } else {
    explain.steps.push('no rule matched; using the source destination block');
  }

  if (rule?.skip) {
    explain.steps.push('rule says skip: true');
    return { skipped: true, reason: `rule[${index}] matched "${rule.match}" and says skip: true`, explain };
  }

  const namespace = rule?.namespace ?? dest.namespace;
  const structure = rule?.structure ?? (rule?.path_template ? 'template' : dest.structure);
  const pathTemplate = rule?.path_template ?? dest.path_template;
  const separator = rule?.flatten_separator ?? dest.flatten_separator;
  const visibilityMode = rule?.visibility ?? dest.visibility;
  const visibility = visibilityMode === 'original' ? (repo.visibility ?? 'private') : visibilityMode;

  explain.steps.push(`namespace = ${namespace}`);
  explain.steps.push(`structure = ${structure}`);
  explain.steps.push(
    visibilityMode === 'original'
      ? `visibility = original, which for this repository is ${visibility}`
      : `visibility = ${visibility}`,
  );

  const relSegments = (repo.relativePath || '').split('/').filter(Boolean);
  let segments;

  if (repo.explicitDestination) {
    segments = repo.explicitDestination.split('/').filter(Boolean);
    explain.steps.push(`pinned by the url list -> ${repo.explicitDestination}`);
  } else if (structure === 'preserve') {
    segments = [...relSegments, repo.repo];
    explain.steps.push(`preserve: [${relSegments.join(', ')}] + ${repo.repo}`);
  } else if (structure === 'flatten') {
    segments = [[...relSegments, repo.repo].map(slugifySegment).join(separator)];
    explain.steps.push(`flatten with "${separator}" -> ${segments[0]}`);
  } else {
    const rendered = renderTemplate(pathTemplate, repo);
    segments = rendered.split('/').filter(Boolean);
    explain.steps.push(`template "${pathTemplate}" -> ${rendered}`);
  }

  const slugged = segments.map(slugifySegment).filter(Boolean);

  const prefix = repo.explicitDestination ? null : (rule?.path_prefix ?? dest.path_prefix);
  if (prefix && slugged.length) {
    slugged[0] = slugifySegment(`${prefix}${slugged[0]}`);
    explain.steps.push(`path_prefix "${prefix}" applied -> ${slugged[0]}`);
  }

  // Filter before slugifying: slugifySegment('') falls back to a literal name.
  const namespaceSegments = (namespace ?? '').split('/').filter(Boolean).map(slugifySegment);

  if (dest.type === 'directory') {
    const relative = [...namespaceSegments, ...slugged].join('/');
    const problem = validatePath(relative);
    if (problem) {
      return { error: `${repo.fullPath} (source "${source.name}") maps to an invalid path: ${problem}`, explain };
    }
    explain.steps.push(`resolved -> ${dest.path}/${relative}${dest.format === 'bare' ? '.git' : ''}`);
    return {
      repo,
      source: source.name,
      type: 'directory',
      root: dest.path,
      format: dest.format,
      path: relative,
      project: slugged.at(-1),
      key: `dir:${dest.path}/${relative}`,
      pushMode: dest.push_mode,
      onRemap: dest.on_remap,
      verify: dest.verify,
      explain,
    };
  }

  if (dest.type === 'github') {
    // GitHub has no nesting: a repository is always exactly owner/name.
    if (!namespaceSegments.length) {
      return {
        error: `source "${source.name}" targets GitHub, which requires \`destination.namespace\` to name the user or organisation that will own the repositories`,
        explain,
      };
    }
    if (slugged.length !== 1) {
      return {
        error:
          `${repo.fullPath} (source "${source.name}") resolves to "${slugged.join('/')}" under ` +
          `${namespaceSegments.join('/')}, but GitHub repositories cannot be nested. ` +
          'Use `structure: flatten` or `structure: template` for a GitHub destination.',
        explain,
      };
    }
    const fullPath = `${namespaceSegments[0]}/${slugged[0]}`;
    const problem = validatePath(fullPath);
    if (problem) {
      return { error: `${repo.fullPath} (source "${source.name}") maps to an invalid path: ${problem}`, explain };
    }
    explain.steps.push(`resolved -> ${dest.connection}:${fullPath}`);
    return {
      repo,
      source: source.name,
      type: 'github',
      connection: dest.connection,
      namespace: namespaceSegments[0],
      subgroups: [],
      project: slugged[0],
      path: fullPath,
      key: `${dest.connection}:${fullPath}`,
      visibility,
      visibilityMode,
      structure,
      onRemap: dest.on_remap,
      disableCi: dest.disable_ci,
      syncMetadata: dest.sync_metadata,
      pushMode: dest.push_mode,
      verify: dest.verify,
      explain,
    };
  }

  let root;
  let subgroups;
  if (namespaceSegments.length) {
    root = namespaceSegments[0];
    subgroups = [...namespaceSegments.slice(1), ...slugged.slice(0, -1)];
  } else {
    if (slugged.length < 2) {
      return {
        error:
          `${repo.fullPath} (source "${source.name}") has no group of its own on the source, and this ` +
          'destination has no `namespace`, so it would become a top-level project. GitLab requires every ' +
          'project to sit in a namespace. Set `destination.namespace`, or use a `rules` entry to give this ' +
          'repository one.',
        explain,
      };
    }
    root = slugged[0];
    subgroups = slugged.slice(1, -1);
    explain.steps.push(`no namespace configured, so "${root}" becomes a top-level group on the destination`);
  }

  const fullPath = [root, ...subgroups, slugged.at(-1)].join('/');

  if (namespaceSegments.length > 1) {
    explain.steps.push(`root namespace ${root}, subgroups below it: ${subgroups.join('/')}`);
  }
  explain.steps.push(`resolved -> ${dest.connection}:${fullPath}`);

  const problem = validatePath(fullPath);
  if (problem) {
    return {
      error: `${repo.fullPath} (source "${source.name}") maps to an invalid destination path: ${problem}`,
      explain,
    };
  }

  return {
    repo,
    source: source.name,
    type: 'gitlab',
    connection: dest.connection,
    namespace: root,
    subgroups,
    project: slugged.at(-1),
    path: fullPath,
    key: `${dest.connection}:${fullPath}`,
    visibility,
    visibilityMode,
    structure,
    onRemap: dest.on_remap,
    autoCreateNamespaces: dest.auto_create_namespaces,
    createRootNamespace: dest.create_root_namespace,
    relaxPushRules: dest.relax_push_rules,
    disableCi: dest.disable_ci,
    syncMetadata: dest.sync_metadata,
    pushMode: dest.push_mode,
    verify: dest.verify,
    explain,
  };
}

export function findCollisions(mappings, connections) {
  const collisions = [];
  const selfMirrors = [];
  const byKey = new Map();

  for (const m of mappings) {
    const key = m.key.toLowerCase();
    const previous = byKey.get(key);
    if (previous) {
      collisions.push({ path: m.path, connection: m.connection ?? m.root, a: previous, b: m });
    } else {
      byKey.set(key, m);
    }

    if (m.type !== 'gitlab') continue;
    const destHost = connections[m.connection]?.host;
    if (
      destHost &&
      destHost.toLowerCase() === String(m.repo.host).toLowerCase() &&
      m.path.toLowerCase() === String(m.repo.fullPath).toLowerCase()
    ) {
      selfMirrors.push(m);
    }
  }

  return { collisions, selfMirrors };
}

export function describeCollision(c) {
  return (
    `  ${c.connection}:${c.path}\n` +
    `    <- ${c.a.repo.fullPath}  (source "${c.a.source}", ${c.a.repo.host})\n` +
    `    <- ${c.b.repo.fullPath}  (source "${c.b.source}", ${c.b.repo.host})`
  );
}

