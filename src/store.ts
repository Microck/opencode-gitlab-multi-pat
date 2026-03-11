import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { GitLabAccount, Store } from './types.js'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'gitlab-multi-pat')
const ACTIVE_FILE = path.join(CONFIG_DIR, 'active.json')
const EXHAUSTED_FILE = path.join(CONFIG_DIR, 'exhausted.json')

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }
}

function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

function saveJson(filePath: string, data: unknown): void {
  ensureDir()
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

// Active store
export function loadActive(): Store {
  const data = loadJson<Store>(ACTIVE_FILE)
  return data || { accounts: [], rotationIndex: 0 }
}

export function saveActive(store: Store): void {
  saveJson(ACTIVE_FILE, store)
}

// Exhausted store
export function loadExhausted(): GitLabAccount[] {
  return loadJson<GitLabAccount[]>(EXHAUSTED_FILE) || []
}

export function saveExhausted(accounts: GitLabAccount[]): void {
  saveJson(EXHAUSTED_FILE, accounts)
}

// Add account to active
export function addAccount(alias: string, pat: string, instanceUrl: string, username?: string): void {
  const store = loadActive()
  
  // Check if exists in active
  const existingIdx = store.accounts.findIndex(a => a.alias === alias)
  if (existingIdx >= 0) {
    store.accounts[existingIdx] = { alias, pat, instanceUrl, username, addedAt: Date.now() }
  } else {
    store.accounts.push({ alias, pat, instanceUrl, username, addedAt: Date.now() })
  }
  
  saveActive(store)
}

// Remove account from active
export function removeAccount(alias: string): void {
  const store = loadActive()
  store.accounts = store.accounts.filter(a => a.alias !== alias)
  saveActive(store)
}

// List active accounts
export function listActive(): GitLabAccount[] {
  return loadActive().accounts
}

// List exhausted accounts
export function listExhausted(): GitLabAccount[] {
  return loadExhausted()
}

// Move account from active to exhausted
export function exhaustAccount(alias: string, reason: string): void {
  const activeStore = loadActive()
  const accountIdx = activeStore.accounts.findIndex(a => a.alias === alias)
  
  if (accountIdx < 0) return
  
  const account = activeStore.accounts[accountIdx]
  account.exhaustedAt = Date.now()
  account.exhaustReason = reason
  
  // Remove from active
  activeStore.accounts.splice(accountIdx, 1)
  
  // Adjust rotation index
  if (activeStore.rotationIndex >= activeStore.accounts.length) {
    activeStore.rotationIndex = 0
  }
  
  saveActive(activeStore)
  
  // Add to exhausted
  const exhausted = loadExhausted()
  exhausted.push(account)
  saveExhausted(exhausted)
}

// Restore exhausted account back to active
export function restoreAccount(alias: string): void {
  const exhausted = loadExhausted()
  const accountIdx = exhausted.findIndex(a => a.alias === alias)
  
  if (accountIdx < 0) return
  
  const account = exhausted[accountIdx]
  delete account.exhaustedAt
  delete account.exhaustReason
  account.addedAt = Date.now()
  
  // Remove from exhausted
  exhausted.splice(accountIdx, 1)
  saveExhausted(exhausted)
  
  // Add back to active
  const activeStore = loadActive()
  activeStore.accounts.push(account)
  saveActive(activeStore)
}

// Get next account (round-robin)
export function getNextAccount(): GitLabAccount | null {
  const store = loadActive()
  if (store.accounts.length === 0) return null
  
  const account = store.accounts[store.rotationIndex % store.accounts.length]
  store.rotationIndex = (store.rotationIndex + 1) % store.accounts.length
  saveActive(store)
  
  return account
}

// Get store paths for CLI info
export function getStorePaths(): { active: string; exhausted: string } {
  return { active: ACTIVE_FILE, exhausted: EXHAUSTED_FILE }
}