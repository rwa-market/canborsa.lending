/**
 * Online backup of the indexer database (B-11):
 *   pnpm --filter @lending/backend db:backup -- <destination-file>
 * Source: DATABASE_PATH (default ./data/lending.db). The backend process does not need to be
 * stopped. For a daily backup: a systemd timer or cron (infra).
 */
import { backupDatabase } from '../db/client.ts'

const source = process.env.DATABASE_PATH ?? './data/lending.db'
const destination =
  process.argv[2] ?? `./data/backup/lending-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
await backupDatabase(source, destination)
console.log(`backup: ${source} -> ${destination}`)
