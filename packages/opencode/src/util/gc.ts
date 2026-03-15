import { Log } from "./log"
import { Database } from "../storage/db"

export namespace GC {
  const log = Log.create({ service: "gc" })

  const LIMIT = 3 * 1024 * 1024 * 1024
  const INTERVAL = 30_000
  const AGGRESSIVE = 0.85
  const GENTLE = 0.7

  const DB_SIZE_THRESHOLD = 500 * 1024 * 1024
  const DB_VACUUM_THROTTLE = 60 * 60 * 1000
  const DB_CHECKPOINT_INTERVAL = 6

  let timer: ReturnType<typeof setInterval> | undefined
  let last = 0
  let dbCheckpointCounter = 0
  let lastVacuum = 0

  export function start() {
    if (timer) return
    timer = setInterval(check, INTERVAL)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    log.info("started", { limit: LIMIT, interval: INTERVAL })
  }

  export function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  function check() {
    const usage = process.memoryUsage()
    const rss = usage.rss
    const heap = usage.heapUsed

    // Run DB maintenance first (always)
    runDBMaintenance()

    if (rss >= LIMIT * AGGRESSIVE) {
      log.warn("memory pressure critical", {
        rss: mb(rss),
        heap: mb(heap),
        limit: mb(LIMIT),
      })
      queueMicrotask(() => {
        Bun.gc(true)
        const after = process.memoryUsage()
        log.info("aggressive gc done", {
          freed: mb(rss - after.rss),
          rss: mb(after.rss),
        })
      })
      last = Date.now()
      return
    }

    if (rss >= LIMIT * GENTLE) {
      log.info("memory pressure moderate", {
        rss: mb(rss),
        heap: mb(heap),
      })
      Bun.gc(false)
      last = Date.now()
      return
    }
  }

  function runDBMaintenance() {
    dbCheckpointCounter++

    if (dbCheckpointCounter >= DB_CHECKPOINT_INTERVAL) {
      dbCheckpointCounter = 0

      // WAL checkpoint
      try {
        Database.checkpoint()
      } catch (e) {
        log.warn("db checkpoint failed", { error: String(e) })
      }

      // Check for VACUUM
      const size = Database.size()
      if (size >= DB_SIZE_THRESHOLD) {
        const now = Date.now()
        if (now - lastVacuum > DB_VACUUM_THROTTLE) {
          try {
            Database.vacuum()
            lastVacuum = now
          } catch (e) {
            log.warn("db vacuum failed", { error: String(e) })
          }
        }
      }
    }
  }

  export function hint() {
    const now = Date.now()
    if (now - last < 5000) return
    Bun.gc(false)
    last = now
  }

  export function aggressive() {
    queueMicrotask(() => {
      Bun.gc(true)
      last = Date.now()
    })
  }

  export function stats() {
    const usage = process.memoryUsage()
    return {
      rss: usage.rss,
      heap: usage.heapUsed,
      total: usage.heapTotal,
      external: usage.external,
      limit: LIMIT,
      pressure: usage.rss / LIMIT,
    }
  }

  function mb(bytes: number) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }
}
