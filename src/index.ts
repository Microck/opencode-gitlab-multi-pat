import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import {
  addAccount,
  loadActive,
  loadExhausted,
  saveActive,
  saveExhausted,
} from './store.js'
import type { GitLabAccount } from './types.js'

const LOG_PATH = path.join(os.homedir(), '.config', 'opencode', 'gitlab-multi-pat.log')

type AuthRecord = {
  type: 'api'
  key: string
  enterpriseUrl?: string
}

type AuthFile = Record<string, unknown> & {
  gitlab?: AuthRecord
}

type SessionStatusEvent = {
  type: 'session.status'
  properties: {
    sessionID: string
    status: {
      type: 'retry' | 'busy'
      message: string
    }
  }
}

type SessionErrorEvent = {
  type: 'session.error'
  properties: {
    sessionID?: string
    error?: {
      name?: string
      message?: string
      data?: {
        message?: string
        statusCode?: number
        responseBody?: string
      }
    }
  }
}

type MessageUpdatedEvent = {
  type: 'message.updated'
  properties: {
    info?: {
      id?: string
      sessionID?: string
      role?: string
      providerID?: string
      modelID?: string
      error?: {
        name?: string
        message?: string
        data?: {
          message?: string
          statusCode?: number
          responseBody?: string
        }
      }
    }
  }
}

type SessionInfo = {
  role?: string
  providerID?: string
  modelID?: string
  model?: {
    providerID: string
    modelID: string
  }
}

type AuthClient = {
  auth: {
    set: (input: {
      path: { id: string }
      body: { type: 'api'; key: string; enterpriseUrl?: string }
    }) => Promise<unknown>
  }
  session: {
    messages: (input: { path: { id: string } }) => Promise<{
      data?: Array<{
        info?: SessionInfo
      }>
    }>
  }
}

const AUTH_FILE_PATHS = [
  path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
  path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
]

const ROTATION_COOLDOWN_MS = 10_000
let lastRotationAt = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessionStatusEvent(event: unknown): event is SessionStatusEvent {
  if (!isRecord(event) || event.type !== 'session.status') return false
  if (!isRecord(event.properties)) return false
  const status = event.properties.status
  if (!isRecord(status)) return false
  return typeof status.message === 'string' && (status.type === 'retry' || status.type === 'busy')
}

function isSessionErrorEvent(event: unknown): event is SessionErrorEvent {
  if (!isRecord(event) || event.type !== 'session.error') return false
  return isRecord(event.properties)
}

function isMessageUpdatedEvent(event: unknown): event is MessageUpdatedEvent {
  if (!isRecord(event) || event.type !== 'message.updated') return false
  return isRecord(event.properties)
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function logLine(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
  const line = `[${new Date().toISOString()}] ${message}${suffix}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 })
    fs.appendFileSync(LOG_PATH, line, 'utf8')
  } catch {
    // ignore logging failures
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
}

function readGitLabAuth(): AuthRecord | null {
  for (const filePath of AUTH_FILE_PATHS) {
    const data = readJson<AuthFile>(filePath, {})
    if (data.gitlab && typeof data.gitlab.key === 'string') {
      return data.gitlab
    }
  }
  return null
}

function writeGitLabAuth(account: GitLabAccount): void {
  for (const filePath of AUTH_FILE_PATHS) {
    const data = readJson<AuthFile>(filePath, {})
    data.gitlab = {
      type: 'api',
      key: account.pat,
      enterpriseUrl: account.instanceUrl,
    }
    writeJson(filePath, data)
  }
}

function findCurrentActiveAccount(): { account: GitLabAccount | null; index: number } {
  const store = loadActive()
  if (store.accounts.length === 0) {
    return { account: null, index: -1 }
  }

  const auth = readGitLabAuth()
  const authIndex = auth ? store.accounts.findIndex((account) => account.pat === auth.key) : -1
  if (authIndex >= 0) {
    return { account: store.accounts[authIndex], index: authIndex }
  }

  const fallbackIndex = Math.min(Math.max(store.rotationIndex, 0), store.accounts.length - 1)
  return { account: store.accounts[fallbackIndex], index: fallbackIndex }
}

function isRotationWorthyMessage(message: string): boolean {
  const text = message.toLowerCase()
  return [
    '402',
    '429',
    '403',
    'rate limit',
    'too many requests',
    'usage limit',
    'quota',
    'insufficient credits',
    'does not have sufficient credits',
    'access denied to gitlab ai features',
    'forbidden',
    'trial',
    'subscription',
    'duo chat is not available',
  ].some((needle) => text.includes(needle))
}

function extractErrorMessage(event: SessionErrorEvent): string {
  const error = event.properties.error
  return error?.data?.message || error?.message || error?.data?.responseBody || ''
}

function extractErrorStatusCode(event: SessionErrorEvent): number | undefined {
  return event.properties.error?.data?.statusCode
}

function extractMessageUpdatedErrorMessage(event: MessageUpdatedEvent): string {
  const error = event.properties.info?.error
  return error?.data?.message || error?.message || error?.data?.responseBody || ''
}

function extractMessageUpdatedErrorStatusCode(event: MessageUpdatedEvent): number | undefined {
  return event.properties.info?.error?.data?.statusCode
}

function isWithinRotationCooldown(): boolean {
  return Date.now() - lastRotationAt < ROTATION_COOLDOWN_MS
}

async function rotateToNextAccount(client: AuthClient, reason: string, source: string): Promise<void> {
  if (isWithinRotationCooldown()) {
    logLine(`rotation skipped (cooldown) from ${source}`, { reason, lastRotationAt })
    return
  }

  // Mark rotation start immediately to prevent concurrent rotations
  lastRotationAt = Date.now()

  const nextAccount = exhaustCurrentAndPickNext(reason)
  if (!nextAccount) {
    console.log('[gitlab-multi-pat] exhausted last active GitLab PAT')
    logLine(`rotation stopped after ${source} because no next account`)
    return
  }

  await setActiveAccount(client, nextAccount)
  console.log(`[gitlab-multi-pat] switched to ${nextAccount.alias}`)
  logLine(`rotation completed from ${source}`, { alias: nextAccount.alias })
}

async function isGitLabSession(client: AuthClient, sessionID: string, message: string): Promise<boolean> {
  try {
    const result = await client.session.messages({ path: { id: sessionID } })
    const lastInfo = result.data?.filter((item) => item.info).at(-1)?.info
    logLine('session lookup result', { sessionID, lastInfo })
    if (lastInfo?.providerID && lastInfo?.modelID) {
      return lastInfo.providerID === 'gitlab'
    }
    if (lastInfo?.model) {
      return lastInfo.model.providerID === 'gitlab'
    }
  } catch (error) {
    logLine('session lookup failed', { sessionID, error: String(error) })
    return isRotationWorthyMessage(message)
  }

  return isRotationWorthyMessage(message)
}

function upsertExhaustedAccount(account: GitLabAccount): void {
  const exhausted = loadExhausted().filter((item) => item.pat !== account.pat)
  exhausted.push(account)
  saveExhausted(exhausted)
}

function exhaustCurrentAndPickNext(reason: string): GitLabAccount | null {
  const store = loadActive()
  if (store.accounts.length === 0) return null

  const current = findCurrentActiveAccount()
  const currentIndex = current.index >= 0 ? current.index : 0
  const currentAccount = store.accounts[currentIndex]

  if (currentAccount) {
    logLine('exhausting active account', { alias: currentAccount.alias, currentIndex, reason })
    const exhaustedAccount: GitLabAccount = {
      ...currentAccount,
      exhaustedAt: Date.now(),
      exhaustReason: reason,
    }
    store.accounts.splice(currentIndex, 1)
    upsertExhaustedAccount(exhaustedAccount)
  }

  if (store.accounts.length === 0) {
    store.rotationIndex = 0
    saveActive(store)
    logLine('no active accounts remain after exhaustion')
    return null
  }

  const nextIndex = currentIndex % store.accounts.length
  store.rotationIndex = nextIndex
  saveActive(store)
  logLine('selected next active account', {
    alias: store.accounts[nextIndex]?.alias,
    nextIndex,
    remainingActive: store.accounts.length,
  })
  return store.accounts[nextIndex] ?? null
}

async function setActiveAccount(client: AuthClient, account: GitLabAccount): Promise<void> {
  logLine('setting active account', { alias: account.alias, instanceUrl: account.instanceUrl })
  writeGitLabAuth(account)
  await client.auth.set({
    path: { id: 'gitlab' },
    body: {
      type: 'api',
      key: account.pat,
      enterpriseUrl: account.instanceUrl,
    },
  })
}

const GitLabMultiPatPlugin: Plugin = async ({ client }) => {
  const typedClient = client as AuthClient
  logLine('plugin startup')
  const current = findCurrentActiveAccount()

  if (current.account) {
    await setActiveAccount(typedClient, current.account)
    console.log(`[gitlab-multi-pat] active account: ${current.account.alias}`)
    logLine('startup active account', { alias: current.account.alias, index: current.index })
  } else {
    console.log('[gitlab-multi-pat] No active accounts available')
    logLine('startup found no active accounts')
  }

  return {
    auth: {
      provider: 'gitlab',
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
              },
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
              },
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
              },
            },
          ],
          async authorize(inputs) {
            const alias = inputs?.alias
            const instanceUrl = inputs?.instanceUrl || 'https://gitlab.com'
            const pat = inputs?.pat

            if (!alias || !pat) {
              return { type: 'failed' as const }
            }

            try {
              const baseUrl = new URL(instanceUrl).origin
              const response = await fetch(`${baseUrl}/api/v4/user`, {
                headers: { Authorization: `Bearer ${pat}` },
              })

              if (!response.ok) {
                return { type: 'failed' as const }
              }

              const user = await response.json()
              addAccount(alias, pat, baseUrl, user.username)

              const activeStore = loadActive()
              if (activeStore.accounts.length === 1) {
                await setActiveAccount(typedClient, activeStore.accounts[0])
              }

              console.log(`[gitlab-multi-pat] Added account: ${alias} (${user.username})`)
              return { type: 'success' as const, key: pat }
            } catch {
              return { type: 'failed' as const }
            }
          },
        },
      ],
    },
    async event({ event }) {
      try {
        logLine('event received', isRecord(event) && typeof event.type === 'string' ? event.type : event)

        // Early cooldown check: skip ALL rotation-worthy events during cooldown window
        if (isWithinRotationCooldown()) {
          // Only log if this is a rotation-worthy event type
          const eventType = isRecord(event) && typeof event.type === 'string' ? event.type : ''
          if (eventType === 'session.status' || eventType === 'session.error' || eventType === 'message.updated') {
            logLine('event skipped (cooldown)', { eventType, lastRotationAt })
            return
          }
        }

        if (isSessionStatusEvent(event)) {
          const message = event.properties.status.message
          logLine('session.status received', {
            sessionID: event.properties.sessionID,
            statusType: event.properties.status.type,
            message,
          })
          if (!isRotationWorthyMessage(message)) return

          const gitlabSession = await isGitLabSession(typedClient, event.properties.sessionID, message)
          logLine('session.status gitlab decision', {
            sessionID: event.properties.sessionID,
            gitlabSession,
          })
          if (!gitlabSession) return

          await rotateToNextAccount(typedClient, message, 'session.status')
          return
        }

        if (isSessionErrorEvent(event)) {
          const message = extractErrorMessage(event)
          const statusCode = extractErrorStatusCode(event)
          logLine('session.error received', {
            sessionID: event.properties.sessionID,
            statusCode,
            message,
            raw: event.properties.error,
          })

          const fullMessage = `${statusCode || ''} ${message}`.trim()
          const worthRotating = isRotationWorthyMessage(fullMessage)
          if (!worthRotating) return

          const gitlabSession = event.properties.sessionID
            ? await isGitLabSession(typedClient, event.properties.sessionID, fullMessage)
            : `${message}`.toLowerCase().includes('gitlab')

          logLine('session.error gitlab decision', {
            sessionID: event.properties.sessionID,
            gitlabSession,
          })
          if (!gitlabSession) return

          await rotateToNextAccount(typedClient, fullMessage, 'session.error')
          return
        }

        if (!isMessageUpdatedEvent(event)) return

        const info = event.properties.info
        if (!info || info.role !== 'assistant' || !info.error) return

        const message = extractMessageUpdatedErrorMessage(event)
        const statusCode = extractMessageUpdatedErrorStatusCode(event)
        const fullMessage = `${statusCode || ''} ${message}`.trim()
        logLine('message.updated error received', {
          sessionID: info.sessionID,
          messageID: info.id,
          providerID: info.providerID,
          modelID: info.modelID,
          statusCode,
          message,
          raw: info.error,
        })

        if (!isRotationWorthyMessage(fullMessage)) return

        const gitlabSession = info.providerID === 'gitlab'
          || (info.sessionID ? await isGitLabSession(typedClient, info.sessionID, fullMessage) : false)

        logLine('message.updated gitlab decision', {
          sessionID: info.sessionID,
          messageID: info.id,
          gitlabSession,
        })
        if (!gitlabSession) return

        await rotateToNextAccount(typedClient, fullMessage, 'message.updated')
      } catch (error) {
        logLine('event handler failed', String(error))
      }
    },
  }
}

export default GitLabMultiPatPlugin
