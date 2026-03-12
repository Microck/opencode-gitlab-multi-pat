import type { GitLabAccount } from './types.js'

const USER_AGENT = 'opencode-gitlab-multi-pat/health-check'

function summarize(status: number, body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ')
  if (status === 200 || status === 201) return 'ok'
  if (status === 401) return 'invalid or revoked token'
  if (status === 403) return 'duo access denied or not enabled'
  if (status === 429) return 'rate limited'
  if (trimmed.length === 0) return `http ${status}`
  return trimmed.slice(0, 200)
}

async function readBody(response: Response): Promise<{ text: string; json?: any }> {
  const text = await response.text()
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    return { text }
  }
}

export interface AccountHealthCheck {
  alias: string
  username?: string
  pool: 'active' | 'exhausted'
  checkedAt: number
  userStatus: number | null
  directAccessStatus: number | null
  patValid: boolean
  usernameMatches: boolean | null
  duoAccess: boolean
  restorable: boolean
  summary: string
}

export async function checkAccountHealth(
  account: GitLabAccount,
  pool: 'active' | 'exhausted',
): Promise<AccountHealthCheck> {
  const checkedAt = Date.now()

  let userStatus: number | null = null
  let directAccessStatus: number | null = null
  let patValid = false
  let usernameMatches: boolean | null = null
  let duoAccess = false
  let summary = 'health check did not complete'

  try {
    const userResponse = await fetch(`${account.instanceUrl}/api/v4/user`, {
      headers: {
        'PRIVATE-TOKEN': account.pat,
        'User-Agent': USER_AGENT,
      },
    })

    userStatus = userResponse.status
    patValid = userResponse.ok

    const userBody = await readBody(userResponse)
    const remoteUsername = typeof userBody.json?.username === 'string' ? userBody.json.username : undefined
    if (account.username && remoteUsername) {
      usernameMatches = account.username === remoteUsername
    }

    const directAccessResponse = await fetch(`${account.instanceUrl}/api/v4/ai/third_party_agents/direct_access`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.pat}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        feature_flags: {
          DuoAgentPlatformNext: true,
          duo_agent_platform_agentic_chat: true,
          duo_agent_platform: true,
        },
      }),
    })

    directAccessStatus = directAccessResponse.status
    const directAccessBody = await readBody(directAccessResponse)
    duoAccess =
      directAccessResponse.ok
      && typeof directAccessBody.json?.token === 'string'
      && !!directAccessBody.json?.headers

    if (duoAccess) {
      summary = 'PAT valid and GitLab Duo direct access is available'
    } else if (!patValid) {
      summary = summarize(userStatus ?? 0, userBody.text)
    } else {
      summary = summarize(directAccessStatus ?? 0, directAccessBody.text)
    }
  } catch (error) {
    summary = String(error)
  }

  return {
    alias: account.alias,
    username: account.username,
    pool,
    checkedAt,
    userStatus,
    directAccessStatus,
    patValid,
    usernameMatches,
    duoAccess,
    restorable: patValid && duoAccess,
    summary,
  }
}
