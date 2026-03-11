# opencode-gitlab-multi-pat

Multi-account Personal Access Token rotation for OpenCode. When a GitLab PAT fails (429/401), it goes to the **exhausted** bucket. No automatic retry. You decide when to bring it back.

## Install

```json
{
  "plugins": ["github:Microck/opencode-gitlab-multi-pat"]
}
```

Or from source:
```bash
git clone https://github.com/Microck/opencode-gitlab-multi-pat.git
cd opencode-gitlab-multi-pat
npm ci
npm run build
```

## Usage

### Add Accounts

Run `/connect` in OpenCode, choose "GitLab PAT (Add Account)" and enter:
- **alias**: e.g., `work`, `personal`
- **instanceUrl**: e.g., `https://gitlab.com` or your self-hosted URL
- **pat**: Your Personal Access Token (starts with `glpat-`)

Repeat for each account you want to rotate through.

### How Rotation Works

1. Requests cycle through active accounts in round-robin order
2. On 429 (rate limit) or 401 (unauthorized): account moves to **exhausted** pool
3. Exhausted accounts are **never** retried automatically
4. When all accounts are exhausted, requests fail with 503

### Managing Accounts

```bash
# List active vs exhausted
gitlab-multi-pat list

# Remove an account completely
gitlab-multi-pat remove work

# Manually exhaust an account (e.g., you know it's dead)
gitlab-multi-pat exhaust personal "Revoked by admin"

# Restore exhausted account back to active pool
gitlab-multi-pat restore personal

# Permanently delete all exhausted accounts
gitlab-multi-pat clear-exhausted

# Show storage file locations
gitlab-multi-pat paths
```

## Storage

```
~/.config/gitlab-multi-pat/
├── active.json      # Being rotated through
└── exhausted.json   # Failed, won't be used
```

Files created with `0o600` permissions.

## Why Two Buckets?

| Bucket | Purpose |
|--------|---------|
| **active** | Healthy tokens in rotation |
| **exhausted** | Dead tokens with failure reason + timestamp |

Unlike cooldown-based systems, this is stateless: a token either works or it's dead. You control resurrection.

## Comparison to Similar Plugins

| | opencode-multi-auth-codex | This |
|---|---------------------------|------|
| Auth type | OAuth (auto-refresh) | PAT (no refresh) |
| Failed tokens | Cooldown + auto-retry | Permanent exhaust |
| Recovery | Automatic | Manual CLI |
| Complexity | 1000+ lines, dashboard, health tracking | 400 lines, two files |
| Use case | High-volume ChatGPT rotation | GitLab PAT rotation |

## Troubleshooting

**All accounts exhausted**
```bash
gitlab-multi-pat list
gitlab-multi-pat restore <alias>  # for each fixed token
```

**PAT validation fails**
- Ensure token starts with `glpat-`
- Check token has `api` or `read_api` scope
- Verify instance URL is correct

**Files not found**
```bash
gitlab-multi-pat paths  # check locations
```

## Files

```
src/
├── index.ts    # Plugin + customFetch
├── store.ts    # Two-file storage logic
├── cli.ts      # CLI commands
└── types.ts    # TypeScript definitions
```

## License

MIT
