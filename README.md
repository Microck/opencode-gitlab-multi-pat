# opencode-gitlab-multi-pat

simple multi-account GitLab PAT rotation for OpenCode.

when a token returns `429` or `401`, this plugin moves it out of rotation and into `exhausted.json`. it stays there until you put it back.

## what it does

- keeps a pool of active GitLab PATs
- rotates requests across that pool in round-robin order
- moves bad tokens to `exhausted.json`
- gives you a small cli to inspect, exhaust, restore, or delete tokens

## install

npm package install:

```bash
npm install opencode-gitlab-multi-pat
```

OpenCode config uses the `plugin` key, not `plugins`:

```json
{
  "plugin": ["opencode-gitlab-multi-pat"]
}
```

local plugin install also works. drop a built file in one of these directories:

```text
.opencode/plugins/
~/.config/opencode/plugins/
```

from source:

```bash
git clone https://github.com/Microck/opencode-gitlab-multi-pat.git
cd opencode-gitlab-multi-pat
npm ci
npm run build
```

then either:

- publish to npm and use the `plugin` array
- or copy the built plugin into your local OpenCode plugin directory

## add accounts

in OpenCode, run `/connect`, pick `GitLab PAT (Add Account)`, then enter:

- `alias` - `work`, `personal`, `spare-1`
- `instanceUrl` - `https://gitlab.com` or your self-hosted GitLab url
- `pat` - a token that starts with `glpat-`

add as many as you want in rotation.

## storage

the plugin keeps two files:

```text
~/.config/gitlab-multi-pat/
|- active.json
`- exhausted.json
```

- `active.json` holds tokens that can still be used
- `exhausted.json` holds tokens that failed, plus the reason and time

files are written with `0o600` permissions.

example:

```json
[
  {
    "alias": "work",
    "instanceUrl": "https://gitlab.com"
  }
]
```

## how requests move

the request path is simple:

1. pick the next token from `active.json`
2. make the request
3. if the response is `429`, move that token to `exhausted.json`
4. if the response is `401`, move that token to `exhausted.json`
5. try the next token
6. if there are no active tokens left, return `503`

example:

- `work` gets `429` -> moved to exhausted
- `personal` gets `200` -> request succeeds
- next request starts from the next active token, not the dead one

there is no cooldown logic. there is no silent retry later. dead tokens stay dead until you restore them.

## cli

```bash
# show active and exhausted pools
gitlab-multi-pat list

# remove an active token completely
gitlab-multi-pat remove work

# mark an active token as dead right now
gitlab-multi-pat exhaust work "revoked by admin"

# move an exhausted token back into rotation
gitlab-multi-pat restore work

# delete all exhausted tokens forever
gitlab-multi-pat clear-exhausted

# print storage paths
gitlab-multi-pat paths
```

## when to restore a token

restore a token only when you actually fixed the problem.

examples:

- you replaced a revoked PAT
- you hit a temporary GitLab limit and want to try again
- you fixed the wrong GitLab instance url

## troubleshooting

if every token is exhausted:

```bash
gitlab-multi-pat list
gitlab-multi-pat restore <alias>
```

if PAT validation fails:

- check that the token starts with `glpat-`
- check that it has the scopes you need, usually `api` or `read_api`
- check that the GitLab instance url is correct

## dev

```bash
npm ci
npm run build
```

ci runs `npm ci` and `npm run build` on pushes and pull requests.

## publish

this repo is set up for npm publish.

```bash
npm login
npm publish
```

after publish, users install the package and reference it like this:

```json
{
  "plugin": ["opencode-gitlab-multi-pat"]
}
```

## license

MIT
