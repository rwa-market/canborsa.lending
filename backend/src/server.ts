import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()
const app = await buildApp(config)

// Slot shutdown on deploy: wait for in-flight requests, release the bot lease
let closing = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    const force = setTimeout(() => process.exit(1), 20_000)
    force.unref()
    void app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
