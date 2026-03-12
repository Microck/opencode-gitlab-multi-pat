#!/usr/bin/env node
import {
  addAccount,
  removeAccount,
  exhaustAccount,
  restoreAccount,
  listActive,
  listExhausted,
  getStorePaths
} from './store.js'
import { checkAccountHealth } from './health.js'

const command = process.argv[2]

function printUsage() {
  console.log(`
GitLab Multi-PAT Plugin CLI

Usage:
  gitlab-multi-pat <command> [args]

Commands:
  list                    List all accounts (active and exhausted)
  remove <alias>          Remove account from active pool
  restore <alias>         Restore exhausted account back to active
  exhaust <alias> [reason] Move active account to exhausted pool
  clear-exhausted         Permanently delete all exhausted accounts
  check <alias>           Verify PAT validity and Duo direct access
  check-recent [count]    Check the most recently exhausted accounts
  paths                   Show storage file locations

Examples:
  gitlab-multi-pat list
  gitlab-multi-pat remove work
  gitlab-multi-pat restore personal
  gitlab-multi-pat exhaust work "Token revoked"
  gitlab-multi-pat check personal
  gitlab-multi-pat check-recent 4
`)
}

function printHealth(result: Awaited<ReturnType<typeof checkAccountHealth>>) {
  console.log(`\n${result.alias}${result.username ? ` (${result.username})` : ''}`)
  console.log(`  Pool:             ${result.pool}`)
  console.log(`  PAT valid:        ${result.patValid ? 'yes' : 'no'}`)
  console.log(`  Username match:   ${result.usernameMatches === null ? 'unknown' : result.usernameMatches ? 'yes' : 'no'}`)
  console.log(`  Duo direct access:${result.duoAccess ? ' yes' : ' no'}`)
  console.log(`  /api/v4/user:     ${result.userStatus ?? 'n/a'}`)
  console.log(`  direct_access:    ${result.directAccessStatus ?? 'n/a'}`)
  console.log(`  Restorable:       ${result.restorable ? 'yes' : 'no'}`)
  console.log(`  Summary:          ${result.summary}`)
}

async function main() {
  switch (command) {
    case 'list': {
      const active = listActive()
      const exhausted = listExhausted()
      
      console.log('\n=== Active Accounts ===')
      if (active.length === 0) {
        console.log('(none)')
      } else {
        active.forEach(acc => {
          console.log(`  ${acc.alias} - ${acc.instanceUrl}${acc.username ? ` (${acc.username})` : ''}`)
        })
      }
      
      console.log('\n=== Exhausted Accounts ===')
      if (exhausted.length === 0) {
        console.log('(none)')
      } else {
        exhausted.forEach(acc => {
          const date = acc.exhaustedAt ? new Date(acc.exhaustedAt).toLocaleString() : 'unknown'
          console.log(`  ${acc.alias} - ${date}`)
          if (acc.exhaustReason) {
            console.log(`    Reason: ${acc.exhaustReason}`)
          }
        })
      }
      
      console.log(`\nTotal: ${active.length} active, ${exhausted.length} exhausted`)
      break
    }
    
    case 'remove': {
      const alias = process.argv[3]
      if (!alias) {
        console.log('Error: Alias required')
        process.exit(1)
      }
      removeAccount(alias)
      console.log(`Removed ${alias} from active pool`)
      break
    }
    
    case 'restore': {
      const alias = process.argv[3]
      if (!alias) {
        console.log('Error: Alias required')
        process.exit(1)
      }
      restoreAccount(alias)
      console.log(`Restored ${alias} to active pool`)
      break
    }
    
    case 'exhaust': {
      const alias = process.argv[3]
      const reason = process.argv.slice(4).join(' ') || 'Manually exhausted'
      if (!alias) {
        console.log('Error: Alias required')
        process.exit(1)
      }
      exhaustAccount(alias, reason)
      console.log(`Moved ${alias} to exhausted pool`)
      break
    }
    
    case 'clear-exhausted': {
      const exhausted = listExhausted()
      if (exhausted.length === 0) {
        console.log('No exhausted accounts to clear')
        break
      }
      console.log(`Deleting ${exhausted.length} exhausted accounts permanently...`)
      const { saveExhausted } = await import('./store.js')
      saveExhausted([])
      console.log('Done')
      break
    }
    
    case 'paths': {
      const paths = getStorePaths()
      console.log('Storage files:')
      console.log(`  Active:    ${paths.active}`)
      console.log(`  Exhausted: ${paths.exhausted}`)
      break
    }

    case 'check': {
      const alias = process.argv[3]
      if (!alias) {
        console.log('Error: Alias required')
        process.exit(1)
      }

      const active = listActive()
      const exhausted = listExhausted()
      const activeMatch = active.find(acc => acc.alias === alias)
      const exhaustedMatch = exhausted.find(acc => acc.alias === alias)
      const account = activeMatch || exhaustedMatch

      if (!account) {
        console.log(`Account not found: ${alias}`)
        process.exit(1)
      }

      const pool = activeMatch ? 'active' : 'exhausted'
      const result = await checkAccountHealth(account, pool)
      printHealth(result)
      break
    }

    case 'check-recent': {
      const count = Number.parseInt(process.argv[3] || '5', 10)
      const exhausted = listExhausted()
        .slice()
        .sort((a, b) => (b.exhaustedAt ?? 0) - (a.exhaustedAt ?? 0))
        .slice(0, Number.isFinite(count) && count > 0 ? count : 5)

      if (exhausted.length === 0) {
        console.log('No exhausted accounts to check')
        break
      }

      for (const account of exhausted) {
        const result = await checkAccountHealth(account, 'exhausted')
        printHealth(result)
      }
      break
    }

    case 'add': {
      console.log('Use /connect in OpenCode to add accounts interactively')
      break
    }
    
    default:
      printUsage()
      process.exit(command ? 1 : 0)
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
