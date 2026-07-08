/**
 * ameba.js — the organism runtime: hook functions that live in the hose.
 * "when data encountered, if match then action." No build step. EXPERIMENTAL.
 *
 * Part of https://github.com/nostr-client — one repo, one thing.
 * License: AGPL-3.0-or-later
 *
 *   import { spawn } from 'https://nostr-client.github.io/ameba/ameba.js'
 *
 *   const bob = await spawn({
 *     name: 'greeter',
 *     filters: [{ kinds: [1], '#t': ['introductions'] }],   // the receptor
 *     action: async ({ event, ctx }) => {                    // the metabolism
 *       await ctx.bus.send({ to: event.pubkey, payload: { hi: '👋 welcome' } })
 *       await ctx.memory.remember('greeted/' + event.pubkey, Date.now())
 *     },
 *   })
 *
 * Refractory membrane (always on): never reacts to its own events, dedupes,
 * ignores events from before it was spawned (unless backlog), rate-limits.
 * The amoeba IS its key: identity, money address, and memory travel with sk.
 */

import { Pool, DEFAULT_RELAYS } from 'https://nostr-client.github.io/pool/pool.js'
import { agentKeys, bus } from './botbus.js'
import { memory } from './memory.js'

export async function spawn({
  name = 'ameba',
  sk,                       // hex secret; omitted → new organism is born
  relays = DEFAULT_RELAYS,
  filters,                  // nostr filters — the receptor
  action,                   // async ({ event, ctx }) — the metabolism
  allow,                    // optional [pubkeys] — only react to these authors
  maxPerMinute = 12,        // metabolic rate limit
  backlog = 0,              // how many historical matches to digest at birth
  log = () => {},
}) {
  const keys = await agentKeys(sk)
  const pool = new Pool(relays)
  const b = await bus(keys, { relays })
  const mem = await memory(keys, { pool })

  const born = Math.floor(Date.now() / 1000)
  const seen = new Set()
  let actions = []            // timestamps for rate limiting
  let alive = true

  const ctx = { keys, pk: keys.pk, bus: b, memory: mem, pool, name, log }

  const subs = filters.map((filter) =>
    pool.subscribe([{ ...filter, limit: backlog }], {
      onEvent: async (event) => {
        if (!alive || seen.has(event.id)) return
        seen.add(event.id)
        if (event.pubkey === keys.pk) return                        // never eat yourself
        if (allow && !allow.includes(event.pubkey)) return          // immune system
        if (!backlog && event.created_at < born - 5) return         // live food only
        const now = Date.now()
        actions = actions.filter((t) => now - t < 60_000)
        if (actions.length >= maxPerMinute) { log(`${name}: rate limited`); return }
        actions.push(now)
        try {
          await action({ event, ctx })
          log(`${name}: acted on ${event.kind}:${event.id.slice(0, 8)}`)
        } catch (err) {
          log(`${name}: action failed — ${err.message ?? err}`)
        }
      },
    })
  )

  log(`${name}: alive as ${keys.pk.slice(0, 8)}…`)
  return {
    ...ctx,
    die() {
      alive = false
      subs.forEach((s) => s.close())
      b.close()
      pool.close()
      log(`${name}: died (memory survives on relays)`)
    },
  }
}
