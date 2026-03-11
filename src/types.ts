export interface GitLabAccount {
  alias: string
  pat: string
  instanceUrl: string
  username?: string
  addedAt: number
  exhaustedAt?: number
  exhaustReason?: string
}

export interface Store {
  accounts: GitLabAccount[]
  rotationIndex: number
}