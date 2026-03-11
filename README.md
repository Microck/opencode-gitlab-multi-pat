# opencode-gitlab-multi-pat

Simple multi-account GitLab PAT rotation for OpenCode.

When a token fails with `429` or `401`, it is moved out of rotation into an exhausted bucket. It is not retried automatically. If you fix it, you restore it yourself.

## What it does

- stores multiple GitLab PATs
- rotates through active tokens in round-robin order
- moves dead tokens to `exhausted.json`
- gives you a small CLI to inspect, restore, or clear exhausted tokens

## Install

OpenCode config:

```json
{
  "plugins": ["github:Microck/opencode-gitlab-multi-pat"]
}
```

From source:

```bash
git clone https://github.com/Microck/opencode-gitlab-multi-pat.git
cd opencode-gitlab-multi-pat
npm ci
npm run build
```

## Add accounts

In OpenCode, run `/connect`, choose `GitLab PAT (Add Account)`, then enter:

- `alias` - `work`, `personal`, `selfhosted`, whatever you want
- `instanceUrl` - `https://gitlab.com` or your self-hosted GitLab URL
- `pat` - your token starting with `glpat-`

Repeat that for every account you want in rotation.

## Rotation model

The plugin uses two files:

```text
~/.config/gitlab-multi-pat/
|- active.json
`- exhausted.json
```

- `active.json` - tokens currently eligible for requests
- `exhausted.json` - tokens removed from use after `429` or `401`, with timestamp and reason

Files are written with `0o600` permissions.

## Failure behavior

Request flow is intentionally simple:

1. pick the next token from `active.json`
2. make the request
3. if the response is `429` or `401`, move that token to `exhausted.json`
4. try the next active token
5. if no active tokens remain, return `503`

There is no cooldown logic and no hidden recovery. A token either works or it is exhausted.

## CLI

```bash
# show both pools
gitlab-multi-pat list

# remove an active token completely
gitlab-multi-pat remove work

# manually mark an active token dead
gitlab-multi-pat exhaust work "revoked by admin"

# move an exhausted token back into rotation
gitlab-multi-pat restore work

# delete all exhausted tokens forever
gitlab-multi-pat clear-exhausted

# print storage paths
gitlab-multi-pat paths
```

## When to restore a token

Use `restore` only after you have actually fixed the underlying problem.

Examples:

- you replaced a revoked PAT
- you want to retry a token that hit a temporary GitLab limit
- you corrected the wrong GitLab instance URL

## Troubleshooting

If every token is exhausted:

```bash
gitlab-multi-pat list
gitlab-multi-pat restore <alias>
```

If PAT validation fails:

- check that the token starts with `glpat-`
- check that it has the scopes you need, usually `api` or `read_api`
- check that the GitLab instance URL is correct

## Dev

```bash
npm ci
npm run build
```

Current CI runs `npm ci` and `npm run build` on pushes and pull requests.

## License

MIT
