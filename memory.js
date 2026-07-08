/**
 * memory.js — private working memory for agents. "Saved Messages" that
 * belong to the key, not the host. No build step. EXPERIMENTAL.
 *
 * Part of https://github.com/nostr-client — one repo, one thing.
 * License: AGPL-3.0-or-later
 *
 * Memory items are NIP-44 encrypted TO YOURSELF and stored on relays:
 *   - kind 30078 (NIP-78 app data), addressable by d-tag → key/value store
 *   - kind 10003 (NIP-51 bookmarks) → forward/bookmark any event with a note
 * Kill the process, respawn anywhere, one REQ recalls everything.
 *
 *   import { memory } from 'https://nostr-client.github.io/ameba/memory.js'
 *   const mem = await memory(me)          // me = { sk, pk } from agentKeys()
 *   await mem.remember('peers/alice', { met: Date.now(), trust: 0.7 })
 *   await mem.recall('peers/alice')       // -> { met, trust }
 *   await mem.recallAll('peers/')         // -> { 'peers/alice': {...}, ... }
 *   await mem.forward(eventId, 'looked useful')
 *   await mem.bookmarks()                 // -> [{ id, note, at }]
 */

import { Pool, DEFAULT_RELAYS } from 'https://nostr-client.github.io/pool/pool.js'

const TOOLS = 'https://esm.sh/nostr-tools@2.10.4'
const KIND_APPDATA = 30078
const KIND_BOOKMARKS = 10003
const NS = 'ameba'  // namespaces our d-tags: d = "ameba/<key>"

const hexToBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)))

export async function memory({ sk, pk }, { relays = DEFAULT_RELAYS, pool } = {}) {
  const [{ finalizeEvent }, nip44] = await Promise.all([
    import(`${TOOLS}/pure`), import(`${TOOLS}/nip44`),
  ])
  const skBytes = hexToBytes(sk)
  const self = nip44.v2.utils.getConversationKey(skBytes, pk) // encrypt-to-self
  const p = pool ?? new Pool(relays)

  const seal = (value) => nip44.v2.encrypt(JSON.stringify(value), self)
  const open = (content) => { try { return JSON.parse(nip44.v2.decrypt(content, self)) } catch { return null } }

  async function publish(kind, tags, value) {
    const event = finalizeEvent({
      kind, created_at: Math.floor(Date.now() / 1000), tags, content: seal(value),
    }, skBytes)
    const results = await p.publish(event)
    if (!results.some((r) => r.ok)) throw new Error('memory write refused by all relays')
    return event
  }

  return {
    /** Durable key/value. Same key overwrites (addressable event). */
    remember: (key, value) => publish(KIND_APPDATA, [['d', `${NS}/${key}`]], value),

    /** One value back, or null. */
    async recall(key) {
      const ev = await p.get({ kinds: [KIND_APPDATA], authors: [pk], '#d': [`${NS}/${key}`] })
      return ev ? open(ev.content) : null
    },

    /** Everything under a prefix → { key: value }. */
    async recallAll(prefix = '') {
      const events = await p.list([{ kinds: [KIND_APPDATA], authors: [pk], limit: 200 }])
      const newest = new Map()
      for (const ev of events) {
        const d = ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''
        if (!d.startsWith(`${NS}/${prefix}`)) continue
        if (!newest.has(d) || newest.get(d).created_at < ev.created_at) newest.set(d, ev)
      }
      const out = {}
      for (const [d, ev] of newest) {
        const value = open(ev.content)
        if (value !== null) out[d.slice(NS.length + 1)] = value
      }
      return out
    },

    /** Forward any event into private bookmarks — "Saved Messages". */
    async forward(eventId, note = '') {
      const current = await this.bookmarks()
      current.push({ id: eventId, note, at: Math.floor(Date.now() / 1000) })
      return publish(KIND_BOOKMARKS, [], current.slice(-500))
    },

    async bookmarks() {
      const ev = await p.get({ kinds: [KIND_BOOKMARKS], authors: [pk] })
      const value = ev ? open(ev.content) : null
      return Array.isArray(value) ? value : []
    },

    close: () => { if (!pool) p.close() },
  }
}
