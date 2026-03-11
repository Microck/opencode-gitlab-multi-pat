import type { Plugin } from '@opencode-ai/plugin'
import {
  loadActive,
  saveActive,
  loadExhausted,
  saveExhausted,
  addAccount,
  removeAccount,
  exhaustAccount,
  restoreAccount,
  getNextAccount,
  listActive,
  listExhausted,
  getStorePaths
} from './store.js'

const GitLabMultiPatPlugin: Plugin = async () => {
  return {
    auth: {
      provider: 'gitlab',

      async loader() {
        const active = listActive()
        if (active.length === 0) {
          console.log('[gitlab-multi-pat] No active accounts. Add one via /connect')
          return {}
        }

        return {
          apiKey: 'multi-pat',
          
          fetch: async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
            const maxAttempts = listActive().length
            const attemptedAliases: string[] = []
            
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              const account = getNextAccount()
              if (!account) {
                return new Response(
                  JSON.stringify({ error: 'No active accounts available' }),
                  { status: 503, headers: { 'Content-Type': 'application/json' } }
                )
              }
              
              if (attemptedAliases.includes(account.alias)) {
                // Already tried this one, skip
                continue
              }
              attemptedAliases.push(account.alias)
              
              // Rewrite URL to use account's instance
              let url: string
              if (input instanceof URL) {
                url = input.toString()
              } else if (input instanceof Request) {
                url = input.url
              } else {
                url = input
              }
              
              // Replace default gitlab.com with account's instance if specified
              if (account.instanceUrl && account.instanceUrl !== 'https://gitlab.com') {
                url = url.replace('https://gitlab.com', account.instanceUrl)
              }
              
              // Build headers with PAT
              const headers = new Headers(init?.headers)
              headers.set('Authorization', `Bearer ${account.pat}`)
              
              try {
                const res = await fetch(url, { ...init, headers })
                
                // Handle failures -> exhaust account
                if (res.status === 429) {
                  const retryAfter = res.headers.get('retry-after')
                  console.log(`[gitlab-multi-pat] ${account.alias} rate limited (429)`)
                  exhaustAccount(account.alias, `Rate limited (429). Retry-After: ${retryAfter || 'unknown'}`)
                  continue // Try next account
                }
                
                if (res.status === 401) {
                  console.log(`[gitlab-multi-pat] ${account.alias} unauthorized (401)`)
                  exhaustAccount(account.alias, 'Unauthorized (401). Token may be revoked or expired.')
                  continue // Try next account
                }
                
                if (!res.ok && res.status >= 400) {
                  // Other errors don't exhaust account, just return the error
                  console.log(`[gitlab-multi-pat] ${account.alias} returned ${res.status}`)
                  return res
                }
                
                // Success
                return res
                
              } catch (err) {
                // Network error - don't exhaust, just log and try next
                console.log(`[gitlab-multi-pat] ${account.alias} network error: ${err}`)
                continue
              }
            }
            
            // All accounts exhausted
            const exhaustedCount = listExhausted().length
            return new Response(
              JSON.stringify({ 
                error: `All ${maxAttempts} active accounts exhausted. ${exhaustedCount} accounts in exhausted pool.` 
              }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            )
          }
        }
      },

      methods: [
        {
          type: 'api',
          label: 'GitLab PAT (Add Account)',
          prompts: [
            {
              type: 'text',
              key: 'alias',
              message: 'Account alias (e.g., work, personal)',
              placeholder: 'work',
              validate: (value?: string) => {
                if (!value) return 'Alias is required'
                return undefined
              }
            },
            {
              type: 'text',
              key: 'instanceUrl',
              message: 'GitLab instance URL',
              placeholder: 'https://gitlab.com',
              validate: (value?: string) => {
                if (!value) return 'Instance URL is required'
                try {
                  new URL(value)
                  return undefined
                } catch {
                  return 'Invalid URL'
                }
              }
            },
            {
              type: 'text',
              key: 'pat',
              message: 'Personal Access Token (starts with glpat-)',
              placeholder: 'glpat-xxxxxxxxxxxxxxxxxxxx',
              validate: (value?: string) => {
                if (!value) return 'PAT is required'
                if (!value.startsWith('glpat-')) return 'PAT should start with glpat-'
                return undefined
              }
            }
          ],
          
          async authorize(inputs) {
            const alias = inputs?.alias
            const instanceUrl = inputs?.instanceUrl || 'https://gitlab.com'
            const pat = inputs?.pat
            
            if (!alias || !pat) {
              return { type: 'failed' }
            }
            
            // Validate PAT by calling /api/v4/user
            try {
              const normalizeUrl = (url: string) => {
                try {
                  const u = new URL(url)
                  return `${u.protocol}//${u.host}`
                } catch {
                  return url
                }
              }
              
              const baseUrl = normalizeUrl(instanceUrl)
              const res = await fetch(`${baseUrl}/api/v4/user`, {
                headers: { Authorization: `Bearer ${pat}` }
              })
              
              if (!res.ok) {
                if (res.status === 401) {
                  console.log('[gitlab-multi-pat] PAT validation failed: Unauthorized')
                }
                return { type: 'failed' }
              }
              
              const user = await res.json()
              addAccount(alias, pat, baseUrl, user.username)
              
              console.log(`[gitlab-multi-pat] Added account: ${alias} (${user.username})`)
              return { type: 'success', key: pat }
              
            } catch (err) {
              console.log('[gitlab-multi-pat] PAT validation error:', err)
              return { type: 'failed' }
            }
          }
        }
      ]
    }
  }
}

export default GitLabMultiPatPlugin