# git-backup-sync

![version](https://img.shields.io/badge/version-1.0.0-blue?style=for-the-badge&logo=github)
![license](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)
![docker hub](https://img.shields.io/badge/docker%20hub-spaaleks%2Fgit--backup--sync-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![quay](https://img.shields.io/badge/quay.io-spaaleks%2Fgit--backup--sync-EE0000?style=for-the-badge&logo=redhat&logoColor=white)

Mirrors git repositories between any number of GitHub accounts, GitLab
instances and folders on a schedule, and tells you about it: quietly when
nothing happens, loudly when it does.

|                  |                                                                               |
| ---------------- | ----------------------------------------------------------------------------- |
| **Sources**      | GitHub, GitLab, or a plain list of clone URLs that needs no API access at all |
| **Destinations** | GitLab, GitHub, or a folder on disk as bare mirrors or working trees          |
| **Reporting**    | email, ntfy, Uptime Kuma, Prometheus                                          |

Any direction between them: GitHub to GitLab, GitLab to GitHub, either to a
folder.

## Features

- **Any number of accounts, any number of destinations.** Two GitHub accounts,
  a GitLab instance and a folder, all in one config, all on one schedule.
- **Full group trees.** A GitLab source's subgroups are recreated on the
  destination, creating only the groups that are missing.
- **No token needed for public repositories.** A plain list of clone URLs works
  with no API access at all, inline or from a file you can regenerate.
- **It refuses to destroy data.** Two repositories resolving to one destination
  aborts the whole run before anything is written, and it names both.
- **It checks its own work.** After pushing it reads the destination back and
  compares every branch and tag.
- **Quiet by default.** Mail arrives when something changed or failed, plus a
  scheduled heartbeat whose absence is itself the alert.
- **Nothing to install.** One container, one YAML file, secrets from the
  environment.

**This is not a migration tool.** Only git objects travel. See
[What does not travel](#what-does-not-travel).

## Contents

- [Quick start](#quick-start)
- [Building from source](#building-from-source)
- [Example workflow](#example-workflow)
- [Configuration reference](#configuration-reference)
- [Mapping cookbook](#mapping-cookbook)
- [Commands](#commands)
- [Email](#email)
- [Monitoring](#monitoring)
- [Safety rails](#safety-rails)
- [Cautions](#cautions)
- [Operating notes](#operating-notes)
- [License](#license)

---

## Quick start

### 1. Make a directory

```bash
mkdir git-backup-sync && cd git-backup-sync
mkdir -p data secrets
```

### 2. `docker-compose.yml`

```yaml
services:
    sync:
        image: spaaleks/git-backup-sync:latest
        # or if you prefer quay.io:
        # image: quay.io/spaaleks/git-backup-sync:latest
        container_name: git-backup-sync
        restart: unless-stopped

        # Let the in-flight repository finish instead of being killed after 10s.
        stop_grace_period: 5m

        # Rootless Docker only. See below.
        user: "0:0"

        env_file:
            - .env

        environment:
            CONFIG_PATH: /config/config.yml
            TZ: Europe/Vienna

        ports:
            # Prometheus metrics and /health.
            - "127.0.0.1:9091:9091"

        volumes:
            - ./config.yml:/config/config.yml:ro
            - ./data:/data
            # Keys must be 0400. OpenSSH refuses a private key that is readable by anyone else.
            - ./secrets:/run/secrets:ro

        # Structured JSON on stdout, no log files in the container.
        logging:
            driver: json-file
            options:
                max-size: "10m"
                max-file: "5"

        security_opt:
            - no-new-privileges:true
```

- **`./data` must be writable by the container.** Under rootless Docker your
  host user maps to container root, so `user: "0:0"` keeps the files owned by
  you. Under a normal daemon, delete that line and run
  `sudo chown -R 1000:1000 ./data` instead.
- **`TZ` sets the zone the cron is evaluated in.** Without it, schedules run in
  UTC and the heartbeat arrives at a surprising hour.

### 3. `config.yml`

```yaml
timezone: Europe/Vienna

schedule:
    sync: "0 3 * * *"
    heartbeat: "0 8 * * 1"

connections:
    github:
        provider: github
        token: ${GH_TOKEN}
        ssh_key: /run/secrets/id_src

    gitlab:
        provider: gitlab
        host: gitlab.example.com
        token: ${GL_TOKEN}
        ssh_key: /run/secrets/id_dst

smtp:
    host: ${SMTP_HOST}
    port: ${SMTP_PORT:-587}
    user: ${SMTP_USER:-}
    password: ${SMTP_PASS:-}
    from: ${SMTP_FROM}
    to: ["${SMTP_TO}"]

sources:
    - name: github
      connection: github
      scope:
          type: user
          login: ${GH_USER}
      destination:
          connection: gitlab
          namespace: mirror
          structure: preserve
```

Everything else has a sensible default. `config-full.example.yml` in the repo
documents every option, with all five mapping shapes worked through.

### 4. `.env`

```bash
# Copy to .env. Never commit it.

# GitHub: lists repositories only, never handed to git.
# Fine-grained token with Metadata: Read-only is enough.
GH_TOKEN=
GH_USER=your-github-login

# GitLab: needs `api`, and must own the destination namespace.
GL_TOKEN=

# Mail. Remove the smtp block from config.yml to run without it.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=git-backup-sync@example.com
SMTP_TO=you@example.com
```

The **GitHub token only lists repositories** — every call is a read-only `GET`
and it is never handed to git, so it needs no write permission and no access to
file contents.

| Provider    | Token            | Minimum permissions                                                 |
| ----------- | ---------------- | ------------------------------------------------------------------- |
| GitHub      | fine-grained PAT | **Metadata: Read-only**. Nothing else needs ticking.                |
| GitHub      | classic PAT      | `repo` for private repositories, or no scope at all for public ones |
| GitLab      | PAT              | `api`, because the destination creates groups and projects          |
| Public URLs | none             | a `provider: git` connection needs no token                         |

The **destination** token must belong to the account that owns the destination
namespace. Writing into someone else's personal namespace needs their token.
This is checked at startup and reported in those words rather than as a bare 403.

Prefer to download the examples rather than paste them:

```bash
base=https://raw.githubusercontent.com/spaaleks/git-backup-sync/main
curl -fsSLO $base/docker-compose.yml
curl -fsSL  $base/config.example.yml -o config.yml
curl -fsSL  $base/.env.example       -o .env
```

### 5. SSH keys

Cloning and pushing go over SSH, not over the API.

```bash
ssh-keygen -t ed25519 -N '' -C 'git-backup-sync' -f secrets/id_src
ssh-keygen -t ed25519 -N '' -C 'git-backup-sync' -f secrets/id_dst
chmod 700 secrets && chmod 400 secrets/id_*
sudo chown -R 1000:1000 secrets
```

Add the public keys as **account** keys on both ends. The destination key needs
**write** access. The whole directory is mounted at `/run/secrets`, so adding a
key later needs no compose change: drop it in and point a connection's
`ssh_key` at `/run/secrets/<name>`.

`chmod 400` is not optional. OpenSSH refuses a private key that group or others
can read, even as root, so every key is checked before the run starts.

### 6. Check the plan before anything runs

```bash
docker compose run --rm sync --check-config
```

It enumerates every source, resolves every mapping, checks for collisions and
prints the whole plan. It writes nothing. **Read the table** — this is the
moment to catch a mapping mistake.

```
resolved mapping
========================================================================
  source github  (github -> gitlab:mirror)
    acme/infra/router      -> gitlab:mirror/infra/router      [CREATE]
    acme/notes             -> gitlab:mirror/notes             [exists]
    acme/scratch/toy       -- skipped (rule[0] matched "^acme/scratch/")
```

### 7. Run it

```bash
docker compose up -d
docker compose logs -f
```

The first run clones everything and sends one email grouped by source. Run it
again and it finds nothing to do and sends nothing. That silence is the intended
steady state.

## Building from source

Only needed if you want to modify it. `docker-compose.local.yml` is the same
file with `build: .` instead of a published image:

```bash
git clone https://github.com/spaaleks/git-backup-sync.git
cd git-backup-sync
docker compose -f docker-compose.local.yml up -d --build
```

The helper scripts in `bin/` follow whatever `COMPOSE_FILE` is set to:

```bash
export COMPOSE_FILE=docker-compose.local.yml
```

## Example workflow

1. **Add a source.** Point it at a GitHub account, a GitLab group, or a list of
   clone URLs.
2. **Run `--check-config`.** Read the resolved mapping. Nothing has been written
   yet.
3. **Start the container.** The first run clones everything and mails you one
   summary grouped by source.
4. **Forget about it.** Nightly runs are silent. You hear from it when a
   repository changes, when something fails, and once a week from the heartbeat.
5. **Notice the heartbeat stopping.** That is the alert that matters: it means
   the service is not running, which is the one failure it cannot report itself.

## Configuration reference

Path from `CONFIG_PATH`, default `/config/config.yml`. That variable plus the
secrets the file references are the only environment input.

### Interpolation

Any string scalar may contain `${VAR}` or `${VAR:-fallback}`.

| Form               | Behaviour                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `${VAR}`           | Required. If `VAR` is unset the service refuses to start, naming the config path and the offending key. It never silently resolves to an empty string. |
| `${VAR:-fallback}` | The fallback is used when `VAR` is unset **or** empty.                                                                                                 |
| `$${...}`          | An escaped `${`, passed through as a literal.                                                                                                          |

Substitution runs after YAML parsing, on string values only. Keys are never
interpolated. It is a single pass: a value that expands to something containing
`${` is left alone.

> **YAML gotcha.** Inside a flow sequence, a bare `${VAR}` is not valid YAML,
> because `{` opens a flow mapping. Quote it:
> `to: [ "${SMTP_TO}" ]`, not `to: [ ${SMTP_TO} ]`.

Any key matching `/secret|pass|token|key/i` is redactable: it prints as `***` in
the startup config dump, in every log line and in every error message. The
exceptions are keys that hold a filesystem path rather than a credential
(`ssh_key`, `known_hosts`, `data_dir`), because hiding those would defeat the
purpose of the dump, which exists so you can see what a `${VAR:-fallback}`
actually resolved to.

The whole document is validated at startup and **unknown keys are rejected**. A
typo'd `include_archved` that silently does nothing is worse than a crash, so
the service exits non-zero naming the failing path
(`sources[3].destination.namespace`) and suggesting the key you probably meant.

### Top level

| Key                       | Default          | Notes                                                                                         |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `data_dir`                | `/data`          | Mirrors and `state.json`. Use a named volume.                                                 |
| `concurrency`             | `4`              | Repositories in flight per source.                                                            |
| `batch_pause_seconds`     | `0`              | Wait after a batch that transferred something. Overridable per source. See [Pacing](#pacing). |
| `batch_pause_min_changes` | `1`              | Ref changes a batch needs before it counts as work worth pausing after.                       |
| `dry_run`                 | `false`          | Enumerate and resolve, create nothing, send nothing.                                          |
| `run_on_start`            | `true`           | Sync at boot rather than waiting for the cron.                                                |
| `log_level`               | `info`           | `error` \| `warn` \| `info` \| `debug`                                                        |
| `timezone`                | `TZ`, then `UTC` | IANA zone the cron is evaluated in. Set it here or as `TZ`, not both.                         |
| `git_timeout_minutes`     | `30`             | Any git invocation is killed after this. Large GitLab to GitLab migrations need more.         |
| `keep_runs`               | `30`             | Run records retained in `state.json`.                                                         |
| `prune_mirrors`           | `true`           | Remove mirror directories nothing references. See [Pruning](#pruning).                        |
| `schedule.sync`           | `0 3 * * *`      | 5-field cron.                                                                                 |
| `schedule.heartbeat`      | none             | 5-field cron. Omit or set `null` to disable.                                                  |

### `connections`

Every credential the service holds, named once. Sources and destinations
reference these by name. Two accounts on the same host are two connections,
because they are two independent rate-limit budgets.

| Key                        | Default  | Notes                                                 |
| -------------------------- | -------- | ----------------------------------------------------- |
| `provider`                 | required | `github` \| `gitlab`                                  |
| `token`                    | required |                                                       |
| `host`                     | derived  | SSH host. Required for `gitlab`.                      |
| `api_url`                  | derived  | `https://api.github.com`, or `https://<host>/api/v4`. |
| `ssh_key`                  | none     | Private key path inside the container.                |
| `ssh_user`                 | `git`    |                                                       |
| `ssh_port`                 | `22`     | A non-default port switches the URL to `ssh://` form. |
| `ssh_options`              | `[]`     | Extra `-o` options.                                   |
| `known_hosts`              | none     | Pin host keys instead of trusting first use.          |
| `strict_host_key_checking` | `false`  | `false` means `accept-new`, never a blind `no`.       |

### `smtp`

| Key                      | Default                               | Notes                                                                                                                       |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | `true`                                | `false` disables all mail, and then nothing else in this block is required. Omitting the whole `smtp:` block does the same. |
| `host`, `port`, `secure` | required when enabled, `587`, `false` | `secure: true` for implicit TLS on 465.                                                                                     |
| `user`, `password`       | empty                                 | Omit both for an unauthenticated relay.                                                                                     |
| `from`                   | required when enabled                 |                                                                                                                             |
| `to`                     | required when enabled                 | A string or a list.                                                                                                         |
| `notify_on`              | `[changes, failures]`                 | Or `[always]`, or `[failures]`. Heartbeats ignore this.                                                                     |
| `subject_prefix`         | `[repo-sync]`                         |                                                                                                                             |
| `retries`                | `3`                                   | Retries per message, with backoff.                                                                                          |

### `defaults`

Inherited by every source unless the source overrides it: `include_forks`,
`include_archived`, `visibility`, `auto_create_namespaces`, `structure`,
`path_template`, `flatten_separator`, `on_remap`, `mirror_wikis`, `mirror_lfs`,
`push_mode`.

### `sources`

| Key                   | Default  | Notes                                                                                                                                    |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | required | Unique and stable. **It is a state key**: renaming one makes every repository under it look new, and retired names must never be reused. |
| `connection`          | required | Credential used to enumerate and fetch.                                                                                                  |
| `scope`               | required | See below.                                                                                                                               |
| `destination`         | required | See below.                                                                                                                               |
| `rules`               | `[]`     | Ordered overrides. First match wins.                                                                                                     |
| `include` / `exclude` | `[]`     | Regex lists against the source `full_path`. `include` is applied first, then `exclude`.                                                  |
| `include_forks`       | inherits |                                                                                                                                          |
| `include_archived`    | inherits |                                                                                                                                          |
| `mirror_wikis`        | inherits |                                                                                                                                          |
| `mirror_lfs`          | inherits |                                                                                                                                          |
| `enabled`             | `true`   | Skip a source without deleting its config or its state.                                                                                  |

#### `scope`

| `type`               | Provider | Enumerates                                                          |
| -------------------- | -------- | ------------------------------------------------------------------- |
| `urls`               | git      | An explicit list of clone URLs. No API, so no token.                |
| `self`               | both     | Everything the token owner can see. Blunt: use `include`/`exclude`. |
| `user`               | both     | That account's own repositories or personal projects.               |
| `org`                | github   | One organisation.                                                   |
| `group`              | gitlab   | One group, `recursive: true` by default, subgroups included.        |
| `projects` / `repos` | both     | An explicit list of paths. No API enumeration.                      |

For `type: user` on GitLab, `include_owned_groups: true` additionally walks
every group the user owns, recursively. That is the "userA and all its groups"
case. `include_membership: true` widens this to groups where the user is merely
a member. It is off by default because it silently pulls in other people's
repositories.

Enumerating a GitHub user who is not the token owner only sees public
repositories. The service warns when this happens.

#### Sources without an API

Some sources cannot give you a token, and public repositories do not need one.
A `provider: git` connection carries credentials for git and nothing else, and
`scope.type: urls` skips enumeration entirely:

```yaml
connections:
    public:
        provider: git
        # ssh_key is optional. Omit it for public https URLs.

sources:
    - name: links
      connection: public
      scope:
          type: urls
          urls:
              - https://github.com/acme/router.git
              - url: https://gitlab.com/acme/net/switch.git
                destination: vendor/switch
```

A pinned `destination` is the **1-to-1 mapping**: that
repository goes exactly there, and `structure`, `path_prefix` and
`path_template` do not apply to it. Unpinned entries take the path from the URL
and go through the normal mapping.

The identity of a URL-list repository is the path from its URL, so
`https://github.com/acme/router.git` behaves like a source repository at
`acme/router`.

#### `destination`

| Key                      | Default                            | Notes                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                   | `gitlab`                           | `gitlab` \| `github` \| `directory`                                                                                                                                                                                                                                                                                                   |
| `connection`             | required for `gitlab` and `github` | Must match the destination type.                                                                                                                                                                                                                                                                                                      |
| `path`                   | required for `directory`           | Folder the mirrors are written into.                                                                                                                                                                                                                                                                                                  |
| `format`                 | `bare`                             | `bare` \| `worktree`, for `type: directory`.                                                                                                                                                                                                                                                                                          |
| `namespace`              | optional                           | Destination path. Only its **first segment** is the root. Deeper segments are created like any other subgroup, so `namespace: userA-mirror/infrastructure` needs `userA-mirror` and creates `infrastructure`. **Omit it** to mirror the source's own top-level groups as top-level groups, which needs `create_root_namespace: true`. |
| `structure`              | `preserve`                         | `preserve` \| `flatten` \| `template`                                                                                                                                                                                                                                                                                                 |
| `path_template`          | `{repo}`                           | Used when `structure: template`.                                                                                                                                                                                                                                                                                                      |
| `flatten_separator`      | `-`                                | Used when `structure: flatten`.                                                                                                                                                                                                                                                                                                       |
| `visibility`             | inherits                           | `private` \| `internal` \| `public` \| `original`. Enforced on every run. See [Visibility](#visibility).                                                                                                                                                                                                                              |
| `auto_create_namespaces` | inherits                           | Create missing groups **below** the root.                                                                                                                                                                                                                                                                                             |
| `create_root_namespace`  | `false`                            | Create the top-level group too. Opt-in.                                                                                                                                                                                                                                                                                               |
| `path_prefix`            | —                                  | Prepended to the first path segment that comes from the source.                                                                                                                                                                                                                                                                       |
| `on_remap`               | inherits                           | `report` \| `archive` \| `delete`. See [Remaps](#remaps).                                                                                                                                                                                                                                                                             |
| `relax_push_rules`       | inherits                           | Disable the destination push rules a mirror cannot satisfy. See [Push rules](#push-rules).                                                                                                                                                                                                                                            |
| `disable_ci`             | `true`                             | Turn off CI on destination projects. See [Pipelines](#pipelines).                                                                                                                                                                                                                                                                     |
| `sync_metadata`          | `true`                             | Copy description, topics and default branch to the destination.                                                                                                                                                                                                                                                                       |
| `push_mode`              | `refspecs`                         | `refspecs` \| `mirror`. See [The push is destructive](#the-push-is-destructive-on-the-destination).                                                                                                                                                                                                                                   |
| `verify`                 | `push`                             | `push` \| `always` \| `off`. See [Verification](#verification).                                                                                                                                                                                                                                                                       |

**Structure semantics.** Source `userA/infra/network/router`, relative path
`infra/network`, repo `router`, destination namespace `mirror`:

| `structure` | Result                                                      |
| ----------- | ----------------------------------------------------------- |
| `preserve`  | `mirror/infra/network/router`, creating subgroups as needed |
| `flatten`   | `mirror/infra-network-router`                               |
| `template`  | `mirror/` plus the rendered template                        |

**Template placeholders:** `{repo}`, `{owner}` (immediate parent), `{group_path}`
(the path below the source root, empty at top level), `{full_path}`, `{source}`,
`{provider}`, `{host}`.

Every rendered segment is slugified to GitLab's allowed character set, and the
result is validated. A path that starts or ends with `-`, contains `..`, or ends
in `.git` or `.atom` is rejected.

#### GitHub destinations

```yaml
destination:
    type: github
    connection: gh-work
    namespace: acme-org # the user or organisation that will own them
    structure: flatten
```

`namespace` is a single user or organisation, never a path: **GitHub
repositories cannot be nested**. A source with any group structure therefore
needs `flatten` or `template`, and `preserve` from a nested source is rejected
at mapping time naming that reason.

The destination token needs write access, unlike the read-only token a GitHub
_source_ needs. It may create repositories under its own account or under an
organisation it can write to; pointing it at another person's account fails
pre-flight with that explanation rather than a 403 mid-run.

| Setting                                                               | Behaviour on GitHub                                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `visibility`                                                          | `private` or `public`. `internal` is GitLab-only and rejected. `original` follows the source. |
| `disable_ci`                                                          | Disables Actions, so a mirrored `.github/workflows` does not run on your account              |
| `sync_metadata`                                                       | Copies description, topics (lowercased, as GitHub requires) and the default branch            |
| `auto_create_namespaces`, `create_root_namespace`, `relax_push_rules` | Meaningless here, and rejected in config                                                      |

Wikis are not mirrored to a GitHub destination.

#### Folder destinations

```yaml
destination:
    type: directory
    path: /data/backup
    format: bare
    structure: preserve
```

| `format`   | Result                                                          | Restorable                                    |
| ---------- | --------------------------------------------------------------- | --------------------------------------------- |
| `bare`     | `<path>/<repo>.git`, exactly what `git clone --mirror` produces | Yes: `git clone /data/backup/acme/router.git` |
| `worktree` | a checkout of the default branch, browsable as files            | **No**: only that branch, at that commit      |

`bare` is the real backup. `worktree` is for when you want to grep the files,
and it cannot restore branches or tags.

For `bare`, `HEAD` on the destination is pointed at the source's default branch
after each push. Without that, cloning the backup checks out a branch that does
not exist and hands you an empty working tree.

`worktree` is derived from the mirror this service already holds, never fetched
from the source a second time, and is reset hard on every run: local edits there
are discarded.

The checks that do not apply to a folder are **rejected rather than ignored**:
`namespace`, `visibility`, `disable_ci`, `relax_push_rules`, `sync_metadata` and
`create_root_namespace` are all config errors on a directory destination, and
`verify: always` is refused for `worktree` because a checkout has no refs to read
back. Everything else works unchanged: collision detection, state, diffing,
pruning, mail and metrics all operate on the resolved path.

#### Where things land

`namespace` is a **container group**, not a prefix. The groups underneath keep
their original names unless `path_prefix` says otherwise. Four shapes, for a
source repository `acme/infra/router` sitting in the group `acme/infra`:

| Config                                      | Result                         |
| ------------------------------------------- | ------------------------------ |
| `namespace: mirror`                         | `mirror/acme/infra/router`     |
| `namespace: mirror` + `path_prefix: "src-"` | `mirror/src-acme/infra/router` |
| no `namespace` + `path_prefix: "src-"`      | `src-acme/infra/router`        |
| no `namespace`                              | `acme/infra/router`            |

The last two put the source's groups at the top level of the destination, which
is what you want when the destination exists to be a faithful copy of an entire
instance rather than a corner of one. The prefix is how two sources share a
destination without their group names colliding.

Omitting `namespace` puts the source's own groups at the top level of the
destination, so it requires `create_root_namespace: true`. Two things are then
rejected, because GitLab has no such thing as a top-level project:

- `structure: flatten` with no namespace, at config validation. Flatten always
  collapses to one path segment.
- A repository that sits in no group on the source, per repository at mapping
  time. Give that source a `namespace`, or a `rules` entry that supplies one.

#### `path_prefix`

Prepended to the first path segment that comes from the source, which is what
keeps two sources from colliding on a shared group name.

| Structure  | Effect on `acme/infra/router`                        |
| ---------- | ---------------------------------------------------- |
| `preserve` | prefixes the top group: `<ns>/src-acme/infra/router` |
| `flatten`  | prefixes the project: `<ns>/src-acme-infra-router`   |

Settable in `defaults`, per destination, or per rule. Omit it and paths are
unprefixed.

#### `rules`

Each rule is `{ match: <regex against the source full_path> }` plus any of
`skip`, `namespace`, `structure`, `path_template`, `flatten_separator`,
`visibility`. First match wins. No match falls through to the source's
`destination` block. A rule that sets `path_template` implies
`structure: template` unless it says otherwise.

Rules are the escape hatch that makes the awkward cases expressible. Put
anything that does not fit a clean structure here rather than inventing more
structure modes.

---

## Mapping cookbook

### `userA -> userB`, one account into another

```yaml
- name: gh-me
  connection: gh-personal
  scope: { type: user, login: ${GH_USER} }
  destination:
    connection: gl-new
    namespace: userB
    # Required, see below.
    structure: flatten
```

`flatten` is not a style choice. GitLab personal namespaces cannot contain
subgroups, so `preserve` into one is impossible the moment a source repository
sits below a group. GitHub has no nesting, so the two are identical for a GitHub
source, but `flatten` states the intent and keeps working if the source ever
moves to GitLab.

### `userA + orgA -> userB`, two sources merged

```yaml
- name: gh-me
  # ... as above, structure: flatten

- name: gh-acme
  connection: gh-work
  scope: { type: org, login: acme-corp }
  destination:
      connection: gl-new
      namespace: userB
      structure: template
      path_template: "acme-{repo}"
```

Without the prefix, `userA/utils` and `acme-corp/utils` both resolve to
`userB/utils` and pre-flight aborts the run. That is the check working, not a
bug. Give one of them a `path_template`.

### `orgA -> orgA`, same name, different instance

```yaml
- name: gh-widgets
  connection: gh-work
  scope: { type: org, login: widgets-inc }
  destination:
      connection: gl-new
      # The group must already exist.
      namespace: widgets-inc
      structure: preserve
```

### `userA` and all its groups, tree recreated

```yaml
- name: gl-migration
  connection: gl-old
  scope:
      type: user
      login: userA
      include_owned_groups: true
      include_membership: false
  destination:
      connection: gl-new
      # A group, because it will hold subgroups.
      namespace: userA-mirror
      structure: preserve
      auto_create_namespaces: true
  rules:
      - match: "^userA/scratch/"
        skip: true
      - match: "^userA/infra/(.*)$"
        namespace: userA-mirror/infrastructure
        path_template: "{repo}"
```

`userA/infra/network/router` lands at `userA-mirror/infrastructure/router`
because rule 2 fires. Everything else lands at
`userA-mirror/<relative path>/<repo>`, with each missing subgroup created below
`userA-mirror`. `userA-mirror` itself must exist.

### A hand-picked list

```yaml
- name: gl-pinned
  connection: gl-old
  scope:
      type: projects
      projects:
          - group-x/service-a
          - group-y/service-b
  destination:
      connection: gl-new
      namespace: archive
      structure: flatten
      flatten_separator: "--"
```

---

## Commands

All of these run against the container:

```bash
docker compose run --rm sync <command>
```

### `--check-config`

```bash
docker compose run --rm sync --check-config
```

Validates, interpolates, enumerates, resolves every mapping, runs every
pre-flight check, and prints the plan. Human output on stdout, JSON logs on
stderr, so `--check-config > plan.txt` gives you a clean file to read or diff.

```
resolved mapping
========================================================================
  source gl-migration  (gl-old -> gl-new:userA-mirror)
    userA/infra/network/router     -> gl-new:userA-mirror/infrastructure/router  [CREATE]
    userA/notes                    -> gl-new:userA-mirror/notes                  [exists]
    userA/scratch/toy              -- skipped (rule[0] /^userA\/scratch\// has skip: true)

destination groups that would be created
========================================================================
  gl-new:userA-mirror/infrastructure
```

Exit code 0 means the plan is sound. Run it after every config edit.

### `--explain <repo>`

```bash
docker compose run --rm sync --explain router
```

Shows which source matched, which rule fired, and how the final path was
rendered, step by step. A rule engine is unreadable without this. It also
explains repositories that were filtered out before mapping, which is usually
the actual question.

Other modes: `--once [source...]`, `--cleanup <source>` (see below), `--unlock`,
`--heartbeat` (send one now), `--health` (the container health check), `--help`.

### Helper scripts

```bash
bin/once                          one sync now, every enabled source
bin/once <source>...              one sync, only those sources
bin/unlock                        show the sync lock, remove it if stale
bin/cleanup <source>              show what undoing a source would remove
bin/cleanup <source> --yes        apply it, after typing the source name to confirm
```

These ship with the source, so they are there if you cloned the repo and absent
if you followed the quick start. They are only convenience wrappers around
`docker compose run --rm sync ...`, adding a directory check and a confirmation
prompt before `bin/cleanup` deletes anything. Every command below works without
them.

`bin/once` points out when the scheduler is already running, since
`docker compose kill -s SIGUSR1 sync` triggers it in place instead of starting a
second container.

### `--unlock`

Only one sync runs at a time, enforced by `sync.lock` in `data_dir`. If a
container is killed the file survives, and `bin/unlock` clears it:

```
lock at /data/sync.lock
  held by   pid 7 on deadcontainer
  since     2026-09-03T06:00:00.000Z
  last seen 1201s ago
  verdict   stale

stale lock removed.
```

A lock refreshed within the last five minutes is reported as alive and left
alone. `--force` removes it anyway.

### `--cleanup <source>`

Undo a mapping that went wrong: delete the destination projects that source
created, drop its local mirrors, and forget its state so the next run starts
clean.

It is dry by default and prints the whole plan. It only ever considers paths
that source recorded in `state.json`, never everything it finds in a namespace,
and it **refuses to delete a project that has commits** unless you also pass
`--force`. `--keep-state` deletes the projects but keeps the state entry.

Two things worth knowing:

- **It depends on state.** If `state.json` does not list the source, cleanup
  has no record of which destination paths were its and will find nothing.
- **GitLab may defer the deletion.** With delayed project deletion enabled, the
  API succeeds and GitLab renames each project to
  `<path>-deletion_scheduled-<id>`, purging it after the retention period. They
  stay visible until then, which is expected rather than a failed delete.

### Triggering a sync by hand

With the scheduler running, signal it:

```bash
docker compose kill -s SIGUSR1 sync
docker compose logs -f
```

The run happens inside the daemon, using the state it already holds. If a sync
is in progress the signal is ignored rather than queued.

Without a scheduler running, a one-off container does the same job:

```bash
docker compose run --rm sync --once
```

Both are safe alongside each other: the lockfile in `data_dir` is shared, so two
syncs cannot overlap, and the scheduler re-reads `state.json` before each run if
another process wrote it in the meantime.

---

## Email

**Never more than one message per run.** Changes and failures in the same run
produce one email with both sections.

### Change mail

Sent when any repository is new, changed, moved, remapped or vanished.

```
Subject: [repo-sync] 3 repos updated, 1 failed
```

The body groups by source, because that is how you think about it: a section per
source with its changed repositories and what changed in each, a failures
section carrying the git stderr, then one line per source with the unchanged
count. It does not enumerate 200 unchanged repositories. Newly created
destination groups are named explicitly, because you want to know the service
just created `userA-mirror/infra/network` on your instance.

### Failure mail

Any failure sends mail, even with nothing else to report. Each failing
repository carries its `consecutiveFailures`, so "broken for six days" reads
differently from a blip. If every repository of one source failed while others
succeeded, the subject says so. If every source sharing a connection failed, the
subject names the connection. That is one dead token, not forty problems.

### Heartbeat mail

Sent on `schedule.heartbeat` unconditionally, regardless of `notify_on`:

- per source: repositories tracked, last success, disk usage, destination
- per connection: reachability, token expiry where the API exposes it,
  rate-limit headroom
- the last ten runs with outcomes
- repositories currently failing, with streaks
- repositories that have never synced successfully
- sources in state but absent from the config, and sources with `enabled: false`
- container uptime and the next scheduled run

**The absence of this mail is itself the alert.** If the weekly heartbeat stops
arriving, the service is not running. Nothing else will tell you. Set a calendar
reminder or a mail filter that flags its absence.

## Monitoring

Three channels with deliberately different jobs. They stack: use all three, or
any one.

| Channel         | Job                                                 | Sends when                                   |
| --------------- | --------------------------------------------------- | -------------------------------------------- |
| **Email**       | The full report, grouped by source, with git stderr | Something changed or failed, per `notify_on` |
| **ntfy**        | A push to your phone, short                         | Same rules as mail                           |
| **Uptime Kuma** | Dead man's switch                                   | **Every run**, unconditionally               |
| **Prometheus**  | Numbers to graph and alert on                       | Scraped                                      |

The distinction that matters: mail and ntfy report _events_, so silence means
nothing happened. Kuma and Prometheus report _liveness_, so silence means
something is wrong. A service that has stopped running cannot send you an event,
which is why the last two exist.

### ntfy

```yaml
ntfy:
    url: ${NTFY_URL:-https://ntfy.sh}
    topic: ${NTFY_TOPIC}
    token: ${NTFY_TOKEN:-}
    priority: default
    failure_priority: high
    notify_on: [changes, failures]
```

Per source, inheriting everything it does not set:

```yaml
sources:
    - name: gl-migration
      ntfy:
          topic: migration-only
```

A source whose topic matches the global one is not sent twice. Failures raise
the priority and change the tag, so they surface differently on your phone.

### Uptime Kuma

There is no API token or password. Create a **Push** monitor in Kuma, set its
heartbeat interval to something comfortably longer than your sync schedule, and
paste the push URL it gives you:

```yaml
uptime_kuma:
    url: ${KUMA_PUSH_URL}
```

**The URL is the credential.** Kuma embeds the push token in the path, so
anyone holding it can mark the monitor up and defeat the whole point of a dead
man's switch. Keep it in `.env` like a password. It is masked to
`https://kuma.example.com/api/push/***` in the startup config dump, and the full
value is scrubbed from log lines and error messages.

The push is a plain `GET` with no headers, so it works through any reverse
proxy. It is pushed after every run with `status=up` or `down`, the run summary as the
message, and the run duration as the ping. Per source:

```yaml
sources:
    - name: gl-migration
      uptime_kuma:
          url: ${KUMA_PUSH_URL_MIGRATION}
```

One monitor per source turns "something is broken" into "this source is broken",
which is usually one expired token rather than a real problem with the mirrors.

Unlike mail and ntfy, this fires on quiet runs too. A run that changed nothing
is still a run that happened, and that is exactly what the monitor watches for.

### Prometheus

```yaml
metrics:
    enabled: true
    host: 0.0.0.0
    port: 9091
    path: /metrics
```

Remove the block to keep the port closed. `docker-compose.yml` binds it to
`127.0.0.1` so it is not published to your network.

Key series:

| Metric                                       | Use                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `gbs_last_run_age_seconds`                   | **The main alert.** Fires whether the run failed or never started.    |
| `gbs_last_run_ok`                            | 0 when the last run aborted or had any failure                        |
| `gbs_source_repos_failing{source}`           | Which source is unhappy                                               |
| `gbs_repo_consecutive_failures{source,repo}` | Only failing repositories are exported, so this is empty when healthy |
| `gbs_source_bytes{source}`                   | Disk growth                                                           |
| `gbs_source_orphaned{source}`                | 1 when a source is in state but gone from the config                  |
| `gbs_next_run_seconds`                       | When to expect the next one                                           |

```yaml
- alert: RepoBackupStale
  expr: gbs_last_run_age_seconds > 172800
  annotations:
      summary: "no repository backup has run in two days"

- alert: RepoBackupFailing
  expr: gbs_repo_consecutive_failures > 3
  annotations:
      summary: "{{ $labels.source }}:{{ $labels.repo }} has failed {{ $value }} runs in a row"
```

`/health` is served on the same port and returns 503 when the last run is older
than twice the sync interval, so it also works as an HTTP container health check.

### Turning mail off

Either omit the `smtp:` block entirely or set `smtp: { enabled: false }`. Nothing
else in the block is required then.

Mail is the only channel that carries the full report grouped by source with git
stderr, and the only one that sends the heartbeat whose _absence_ tells you the
service died. Turning it off is reasonable if [ntfy or Uptime
Kuma](#monitoring) covers you instead. With none of them configured, a
repository failing for six days says so only in the container logs, and the
service warns about exactly that at startup.

### Delivery failures

SMTP is retried three times with backoff, then the full intended body is logged
at `error` level. A mail failure never crashes the process or aborts a sync.

---

## Safety rails

Everything in this section runs **before** any git or write API call.

**Path collisions.** Two repositories resolving to one destination path abort the
entire run, naming both repositories and their sources and suggesting a fix.
Silently mirroring two repositories into one project destroys data. Multi-source
configs make this easy to hit: `userA/utils` and `orgA/utils` both flatten to
`utils`.

**Self-mirroring.** A destination that resolves to the same host and path as its
source aborts the run. With GitLab on both ends this is one typo away, and
pushing a mirror onto its own source is unrecoverable.

**Namespace ownership.** The destination token's ability to write to each root
namespace is checked once per namespace at the start of the run, not per
repository at push time.

**Personal namespaces.** `structure: preserve` into a GitLab personal namespace
is rejected as soon as any source repository needs a subgroup, with the
limitation named. `--check-config` reports it as a hard error. During a
scheduled run it fails only that source, so one bad mapping does not stop the
other sources at 3am.

**Root namespaces are not created unless you ask.** If `namespace: userA-mirror`
does not exist the run stops, because auto-creating a top-level group from a
typo leaves debris you then clean up by hand. "Root" means the first segment of
`namespace`, so `userA-mirror/infrastructure` requires `userA-mirror` to exist
and creates `infrastructure` for you.

Set `create_root_namespace: true` on the destination when you do want it made.
The service checks `can_create_group` on the destination token first, so a token
that is not allowed to create top-level groups fails pre-flight with that reason
rather than a 403 mid-run. Concurrent repositories share one create, so thirty
repositories starting at once produce one `POST /groups`, not thirty.

---

## Cautions

### The push is destructive on the destination

Refs that are absent locally are deleted there. That is correct for a one-way
mirror and wrong the moment anyone commits on the destination side. With GitLab
on both ends the risk is sharper, because the destination looks like a normal
working project to everyone else. Treat destination projects as read-only.

`push_mode` controls how:

| Mode                 | Command                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `refspecs` (default) | `git push --prune --force` over `refs/heads/*`, `refs/tags/*`, `refs/notes/*` |
| `mirror`             | a literal `git push --mirror`                                                 |

The default is `refspecs` because plain `--mirror` fails against a GitLab
destination that has merge requests: it tries to delete the server-generated
`refs/merge-requests/*` that the local mirror does not have, and GitLab refuses
the push. Both modes are equally authoritative for branches and tags. Use
`mirror` only if you specifically want every other ref namespace mirrored too.

Provider bookkeeping refs (`refs/pull/*`, `refs/merge-requests/*`,
`refs/keep-around/*`, `refs/pipelines/*`) are dropped from the local mirror after
each fetch. They are noise, and GitLab regenerates its own set anyway.

### Git LFS

`--mirror` does not carry LFS blobs, and the push omits them silently. This
service always detects LFS in `.gitattributes` and says so prominently in the
mail. Set `mirror_lfs: true` to actually transfer them with
`git lfs fetch --all` and `git lfs push --all`. The image ships `git-lfs`.
GitLab to GitLab migrations hit this far more often than GitHub ones.

### Verification

`verify` defaults to `push`: after writing to a destination, the service reads
it back with `git ls-remote` and compares every branch and tag against the local
mirror. A mismatch fails that repository with the refs named.

```
the destination gl-new:mirror/acme/infra/router does not match the mirror after pushing (14 refs checked)
  missing there: refs/tags/v1
  Something on the destination side rejected or altered part of the push.
  The backup is not a faithful copy until this clears.
```

This exists because "the push exited 0" and "the copy is correct" are not the
same claim, and for a backup only the second one matters. Push rules, server-side
hooks and quota limits can all accept a push and then change what landed.

| Value            | Behaviour                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `push` (default) | Verify when something was actually written: new, changed, or push rules relaxed. Unchanged repositories cost no extra round trip. |
| `always`         | Verify every repository every run. Catches drift caused on the destination side between runs, at one `ls-remote` per repository.  |
| `off`            | Trust the push.                                                                                                                   |

Note that a mirror is self-healing: the next push restores anything the
destination lost, because the local mirror is authoritative. Verification is
what tells you it happened.

### Visibility

| Value               | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `private` (default) | Every destination project is private.                                        |
| `internal`          | Visible to any signed-in user of the destination instance.                   |
| `public`            | Visible to everyone.                                                         |
| `original`          | Whatever the source repository is set to right now, resolved per repository. |

**It is enforced on every run, not only at creation.** Change `visibility` in
the config and the next run applies it to projects that already exist, including
ones created under a different setting. `--explain` shows what `original`
resolved to for a given repository.

This deliberately breaks the "new projects only" convention that the rest of the
destination settings follow, because the alternative is worse: a mirror told to
go private that stayed public would be a privacy failure, not a cosmetic one.

Restricting and widening are treated differently when GitLab refuses the change:

- **Restricting** (public to private, say) that fails is a hard error for that
  repository. If you asked for private and did not get private, you need to know.
- **Widening** that fails is reported as a warning and the sync continues. GitLab
  caps a project at its namespace's visibility, so a public source repository
  mirrored into a private group cannot be public, and with `original` that is
  expected rather than broken.

### Metadata

`sync_metadata` defaults to `true` and copies `description`, `topics` and
`default_branch` from the source to the destination, updating only what differs.

`default_branch` matters more than it looks. GitLab picks a default when a
project receives its first push, and with several branches arriving at once it
does not necessarily pick the one the source uses, so the mirror can open on the
wrong branch. It is only set once that branch actually exists on the
destination.

The source is authoritative: a description edited on the destination is
overwritten on the next run.

### Pruning

`prune_mirrors` defaults to `true` and removes mirror directories under
`data_dir` that nothing references any more, reporting what it reclaimed.

It is driven by **state, not by what the source currently reports**. A
repository that vanished from its source stays in state, so its mirror is kept:
that copy may be the only one left, which is the entire point of a backup. What
this removes is litter, such as the directory left behind when a repository
moves between sources.

### Pipelines

`disable_ci` defaults to **`true`**, and it is the one destination setting that
is also enforced on projects that already exist.

A mirror carries `.gitlab-ci.yml` along with everything else, and GitLab runs it
on your own runners on every push. For a backup that is waste at best. At worst
a pipeline with a deploy stage deploys from the backup, or a scheduled job in
the mirrored config starts firing against your infrastructure. You did not ask
for either by taking a backup.

The service sets `builds_access_level: disabled` and `auto_devops_enabled:
false`. Auto DevOps has to go too, because it runs a pipeline on a project that
has no `.gitlab-ci.yml` at all.

At project creation these go in the create call, costing no extra request. For
an existing project the state comes from the lookup the service already does, so
a project that is already correct costs nothing either. If somebody turns CI
back on, the next run turns it off again and says so in the mail.

This deliberately breaks the rule that `visibility` follows, where new projects
are configured and existing ones are left alone. A running pipeline is an active
hazard rather than a preference. Set `disable_ci: false` to manage CI yourself.

Nothing else about the destination project is touched: issues, merge requests
and the rest keep whatever settings they have.

### Push rules

GitLab's `commit_committer_check` push rule ("Reject unverified users") rejects
any commit whose committer email is not a verified email of the pushing account:

```
remote: GitLab: You cannot push commits for 'noreply@github.com'.
 ! [remote rejected] dev -> dev (pre-receive hook declined)
```

It fires on some repositories and not others, which makes it look intermittent.
Every commit made through GitHub's web interface is committed as
`noreply@github.com`, so a repository where you once clicked "Merge" in the
browser carries an identity your GitLab account will never own, while one you
only ever pushed from a laptop goes through untouched.

No mirror can satisfy this rule. Rewriting the committer emails would change
every commit SHA, which is precisely what a mirror must not do, and the rewrite
would have to be redone on every fetch.

Set `relax_push_rules: true` on the destination and the service disables the
identity checks (`commit_committer_check`, `commit_committer_name_check`,
`member_check`, `reject_unsigned_commits`, `author_email_regex`) on the projects
it manages. What it changed is named in the mail.

It applies them **before the first push** on any project or group it creates,
rather than waiting for a rejection. A rejected push uploads every object and is
only refused by the pre-receive hook at the end, so reacting after the fact
throws away a whole transfer. For projects that already existed the reactive
path still applies: the push is tried, the rule relaxed, the push retried once.

A project-level rule overrides the instance default, but **it cannot override a
rule enforced on the parent group**. If the retry still fails the error says so,
and you have to turn the rule off at Group → Settings → Repository → Push rules,
or in the Admin area.

Leave it `false` and the failure is reported with that explanation attached
rather than as bare git stderr.

### Repositories that cannot be cloned

Some repositories are visible through the API but impossible to clone. The most
common cause is a project whose repository feature has been switched off, which
fails with a message that reads like a permissions problem and is not one:

```
remote: You are not allowed to download code from this project.
```

Enumeration already returns `repository_access_level`, so these are detected
before any git runs and skipped rather than attempted. The same applies to a
token holding less than Reporter access, which can see a project but not
download its code. Nothing is cloned, nothing fails, and the source server is
not asked a question whose answer is already known.

They are **not** folded into the filtered count. "Excluded on purpose" and
"cannot be backed up" are different facts, and only one of them should worry
you. `--check-config` names them, the per-source line in the mail
marks them `UNREADABLE`, and a run-level warning lists them:

```
source "acme": 2 repositories cannot be cloned and are not being backed up
  (acme/hosting/legacy-site, acme/hosting/old-site)
```

### Empty repositories

A source repository with no branches or tags is not an error. The destination
project is still created, nothing is pushed, and the repository starts mirroring
by itself once it gets its first commit. Without this, git exits 1 with
`No refs in common and none specified` and the repository would be reported as
failing forever.

### Wikis

Opt-in, per source or in `defaults`, with `mirror_wikis: true`.

The wiki is a separate `<path>.wiki.git` repository. When enabled, the service
probes the source wiki. If it clones and is not empty, the destination project's
wiki is enabled and the wiki is pushed. A missing or empty source wiki is a
silent no-op, not a failure, and a wiki failure never fails the repository
itself: it appears as a sub-line under that repository in the mail.

### What does not travel

Nothing outside git. Issues, merge requests and pull requests, snippets, CI/CD
variables, releases, container and package registries, project settings, labels,
milestones, members. Do not mistake this for a migration tool.

### Remaps

When a config edit changes where a repository resolves, that is a mapping event,
not a repository event. It is reported as `remapped` with the old and new paths.
`on_remap` decides what happens to the project at the old path:

| Mode               | Behaviour                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report` (default) | Nothing is touched. The mail names both paths.                                                                                                                                                                                                                                              |
| `archive`          | The old project is archived: reversible, out of the active project list, data kept.                                                                                                                                                                                                         |
| `delete`           | The old project is deleted, but **only** if state records that this service created it and its current refs still match the last mirrored state. If anyone pushed there, or the check cannot be made, it downgrades to `report` and says why in the mail. Refused entirely under `dry_run`. |

A long migration that adjusts paths a few times accumulates clutter, which is
what `archive` is for. `delete` exists for people who are sure, and it is
deliberately hard to trigger by accident.

### The mirror volume grows without bound

Nothing is ever pruned automatically. Per-source disk usage is in every
heartbeat. A repository that vanishes from its source is reported but never
deleted, locally or on the destination.

---

## Operating notes

### State

`${data_dir}/state.json`, written atomically (temp file, then rename).

- A corrupt or missing state file is survivable: the service warns, keeps the
  corrupt file for inspection, treats every repository as new, and carries on.
- Removing a source from the YAML does **not** delete its state or its mirrors.
  It is reported once per heartbeat as orphaned. A source commented out for an
  afternoon should not cost a full re-clone.
- Repository identity is the triple `(source, provider+host, full_path)`, never
  the bare repository name.

### Moves

A repository that vanishes from one source and appears in another, sharing at
least one commit, is reported as a single move rather than a disappearance plus
an unrelated arrival. GitLab project transfers make this common. Matching is by
shared commit object, never by name, because "utils" appearing in two accounts is
exactly the case that must not be merged.

### Failure handling

- One repository failing never aborts the run.
- One source failing to enumerate skips that source. The others continue.
- Every git invocation is timed out (`git_timeout_minutes`) so a hung transfer
  cannot wedge the scheduler.
- Rate limiting is tracked per connection, not globally. GitHub's
  `X-RateLimit-*` and GitLab's `RateLimit-*` headers are read and respected.
  Different tokens have independent budgets.
- Never two syncs at once: an in-process flag plus a lockfile in `data_dir`.
  The holder touches the file every 30 seconds, and a lock untouched for five
  minutes is treated as stale. That matters in Docker, where every run has a new
  hostname, so a PID check cannot see across containers and a killed container
  would otherwise hold the lock until it aged out.

### Pacing

`batch_pause_seconds` throttles a source so a large migration does not hammer
either server.

At `0`, the default, repositories run through a continuous worker pool: a free
slot is filled immediately, so one slow repository never holds up the others.
Any value above `0` switches that source to fixed batches of `concurrency`,
because a pause needs a boundary to pause at. That costs a little throughput,
since each batch waits for its slowest member.

**Only batches that did work are waited out.** The pause exists to go easy on
the servers, and a batch of already-current repositories gives them nothing to
recover from. A batch is worth pausing after when it contains a **first clone**,
which is the expensive case, or when its repositories changed at least
`batch_pause_min_changes` refs between them. Raise that if you only want a pause
after genuinely heavy batches.

The practical effect on a source of 34 repositories at `concurrency: 4` and a
five minute pause:

| Run                                        | Pauses | Added  |
| ------------------------------------------ | ------ | ------ |
| steady state, nothing changed              | 0      | none   |
| a normal night, a few repositories changed | 1      | 5 min  |
| first run, everything cloned               | 8      | 40 min |

```yaml
concurrency: 4
batch_pause_seconds: 300

sources:
    - name: big-migration
      batch_pause_seconds: 600
```

The pause is interrupted by a shutdown signal rather than blocking it.

### Signals

Git runs in its own process group, so a Ctrl-C in the terminal does not kill a
transfer half way through. That means the first signal starts a graceful
shutdown and waits for the repositories already in flight:

```
finishing the repositories already in flight, send the signal again to abort now
```

**Send the signal a second time to abort immediately.** That kills every running
git process and exits 130. Without it a large clone would leave you waiting with
no way out.

`docker-compose.yml` sets `stop_grace_period: 5m` so `docker compose down` gives
the in-flight repository time instead of killing it after ten seconds.

| Signal               | Effect                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SIGUSR1`            | Run a sync now, without waiting for the cron. Ignored if one is already running.                                              |
| `SIGTERM` / `SIGINT` | Stop scheduling, finish the in-flight repository, write state, exit 0.                                                        |
| `SIGHUP`             | Reload the config. It is validated fully first, and the old config is kept on any error. Never runs on a half-applied config. |

## License

MIT, Copyright (c) 2026 Aleksandar Spasojevic. See [LICENSE.md](LICENSE.md).
