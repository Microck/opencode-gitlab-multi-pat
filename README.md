# opencode-gitlab-multi-pat

multi-account GitLab PAT rotation for OpenCode.

when a GitLab Duo request fails with a credit/quota error (402, 429, etc.), this plugin exhausts the current account and switches to the next one — no manual intervention, no service interruption.

## what it does

- keeps a pool of active GitLab PATs in `~/.config/gitlab-multi-pat/active.json`
- on startup, sets the first active account as the GitLab auth credential
- listens to OpenCode events (`session.error`, `message.updated`, `session.status`)
- sanitizes historical tool call IDs before chat history is sent to Anthropic-compatible GitLab models
- when a rotation-worthy failure is detected on a GitLab session:
  1. exhausts the current account (moves it to `exhausted.json`)
  2. switches auth to the next active account via `client.auth.set()`
  3. logs the rotation to `~/.config/opencode/gitlab-multi-pat.log`
- 10-second cooldown prevents duplicate events from burning multiple accounts per failure

## install

npm:

```bash
npm install opencode-gitlab-multi-pat
```

OpenCode config (`opencode.json`) — uses the `plugin` key, not `plugins`:

```json
{
  "plugin": ["opencode-gitlab-multi-pat"]
}
```

local install also works. copy a built plugin into one of:

```text
.opencode/plugins/opencode-gitlab-multi-pat/
~/.config/opencode/plugins/opencode-gitlab-multi-pat/
```

from source:

```bash
git clone https://github.com/Microck/opencode-gitlab-multi-pat.git
cd opencode-gitlab-multi-pat
npm ci && npm run build
cp -r dist/ ~/.config/opencode/plugins/opencode-gitlab-multi-pat/dist/
cp package.json ~/.config/opencode/plugins/opencode-gitlab-multi-pat/
```

## add accounts

in OpenCode, run `/connect`, pick `GitLab PAT (Add Account)`, then enter:

- `alias` — `work`, `personal`, `spare-1`, etc.
- `instanceUrl` — `https://gitlab.com` or your self-hosted GitLab url
- `pat` — a token that starts with `glpat-`

the plugin validates the PAT against `/api/v4/user` before adding it. add as many accounts as you want.

## storage

```text
~/.config/gitlab-multi-pat/
├── active.json      # accounts available for rotation
└── exhausted.json   # accounts that failed, with reason and timestamp
```

files are written atomically (write to `.tmp`, then rename) with `0o600` permissions.

the plugin also writes to both OpenCode auth files:

```text
~/.config/opencode/auth.json
~/.local/share/opencode/auth.json
```

## how rotation works

the plugin is event-driven, not a request proxy. it hooks into the OpenCode event bus:

1. OpenCode emits `session.error`, `message.updated`, or `session.status` when a request fails
2. the plugin checks if the error message contains rotation-worthy signals:
   - `402`, `429`, `403`
   - `rate limit`, `too many requests`, `usage limit`, `quota`
   - `insufficient credits`, `does not have sufficient credits`
   - `access denied to gitlab ai features`, `forbidden`
   - `trial`, `subscription`, `duo chat is not available`
3. the plugin confirms the failing session belongs to the `gitlab` provider (via `client.session.messages()`)
4. if confirmed: exhaust current account → pick next → write auth files → call `client.auth.set()`
5. a 10-second cooldown prevents duplicate events from the same failure from exhausting multiple accounts

### chat switch compatibility

some older chats can contain historical tool call IDs with characters Anthropic rejects (for example `.` or `/`). before OpenCode sends message history to GitLab Opus, the plugin rewrites those historical tool IDs into Anthropic-safe IDs so chat switching does not fail on `tool_use.id` validation.

### the duplicate event problem

OpenCode emits the same failure through multiple event channels — a single 402 can fire both `session.error` and `message.updated` within ~100-400ms. without protection, a naive listener would exhaust 2+ accounts per failure.

this plugin handles it with an early cooldown gate: `lastRotationAt` is set immediately when rotation begins (before exhausting the current account), so the second event is blocked by the cooldown check before it can do any async work.

## cli

```bash
# show active and exhausted pools
gitlab-multi-pat list

# verify one account still has PAT + Duo access
gitlab-multi-pat check <alias>

# verify the most recently exhausted accounts
gitlab-multi-pat check-recent 5

# remove an active token completely
gitlab-multi-pat remove <alias>

# mark an active token as dead right now
gitlab-multi-pat exhaust <alias> "reason"

# move an exhausted token back into rotation
gitlab-multi-pat restore <alias>

# delete all exhausted tokens forever
gitlab-multi-pat clear-exhausted

# print storage paths
gitlab-multi-pat paths
```

## when to restore a token

restore a token only when you actually fixed the problem:

- you replaced a revoked PAT
- you hit a temporary GitLab limit and want to try again
- the trial was renewed or credits were replenished

before restoring, you can probe the account directly:

- `gitlab-multi-pat check <alias>` validates the PAT against `/api/v4/user` and GitLab Duo access against `/api/v4/ai/third_party_agents/direct_access`
- `Restorable: yes` means the token is valid and Duo direct access is still available
- this check does **not** guarantee the account has remaining inference credits for every model request, but it does prove the PAT is not simply dead or missing Duo access

## troubleshooting

**all tokens exhausted:**

```bash
gitlab-multi-pat list
gitlab-multi-pat restore <alias>
```

**PAT validation fails on /connect:**

- check that the token starts with `glpat-`
- check that it has the scopes you need (`api` or `read_api`)
- check that the GitLab instance url is correct

**rotation not firing:**

- check `~/.config/opencode/gitlab-multi-pat.log` for event traces
- look for `event skipped (cooldown)` if you suspect the cooldown is too aggressive
- verify the session is actually using the `gitlab` provider (the plugin confirms this before rotating)

**plugin not loading:**

- opencode uses `plugin` (singular), not `plugins`
- restart opencode after config changes
- check that the plugin file exists at the configured path

## logs

rotation events are logged to:

```text
~/.config/opencode/gitlab-multi-pat.log
```

every event is timestamped. the log includes:
- plugin startup and active account selection
- all received events (type only, no sensitive data)
- session provider lookups
- rotation decisions (cooldown skips, exhaustions, switches)
- errors in the event handler itself

## dev

```bash
npm ci
npm run build
```

## publish

```bash
npm login
npm publish
```

## license

MIT
