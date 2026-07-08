/**
 * botbus.js — typed real-time messaging for agents ("telegram for bots").
 * No build step. Transport = nostr relays; identity = keypairs; envelope =
 * typed events. See PROTOCOL.md. EXPERIMENTAL.
 *
 * Part of https://github.com/nostr-client — one repo, one thing.
 * License: AGPL-3.0-or-later
 *
 *   import { agentKeys, bus, channelKeys } from 'https://nostr-client.github.io/ameba/botbus.js'
 *
 *   const me = await agentKeys()                    // or agentKeys(skHex)
 *   const b = await bus(me)
 *   b.listen({ channel }, ({ payload, reply }) => reply({ pong: payload.ping }))
 *   await b.send({ channel, payload: { ping: 1 } })
 *
 * Channels:
 *   public      — plaintext, anyone can read           { id }
 *   shared-key  — confidential to key holders          { id, sk }  (channelKeys())
 *   direct      — NIP-44 encrypted to one recipient    send({ to })
 */

import { Pool, DEFAULT_RELAYS } from 'https://nostr-client.github.io/pool/pool.js'

const TOOLS = 'https://esm.sh/nostr-tools@2.10.4'
export const KIND_MSG = 4242        // durable machine message (experimental)
export const KIND_EPHEMERAL = 24242 // realtime-only: delivered, never stored

let _tools = null
async function tools() {
  if (!_tools) {
    const [pure, nip44] = await Promise.all([import(`${TOOLS}/pure`), import(`${TOOLS}/nip44`)])
    _tools = { ...pure, nip44 }
  }
  return _tools
}

const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const hexToBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)))

/** An agent identity. Persisted by the caller (it IS the agent). */
export async function agentKeys(skHex) {
  const { generateSecretKey, getPublicKey } = await tools()
  const sk = skHex ? hexToBytes(skHex) : generateSecretKey()
  return { sk: bytesToHex(sk), pk: getPublicKey(sk) }
}

/** A shared-key channel: whoever holds sk can read; writers sign as themselves. */
export const channelKeys = agentKeys

/**
 * Open a bus for an agent. Returns { pk, send, listen, close }.
 */
export async function bus({ sk, pk }, { relays = DEFAULT_RELAYS } = {}) {
  const t = await tools()
  const skBytes = hexToBytes(sk)
  const pool = new Pool(relays)
  const seen = new Set()

  const convKey = (otherPk) => t.nip44.v2.utils.getConversationKey(skBytes, otherPk)

  function encodePayload(payload, type) {
    if (type === 'application/json' || type === undefined) return [JSON.stringify(payload), 'application/json']
    if (type.startsWith('text/')) return [String(payload), type]
    // binary (protobuf, bson, …): caller passes Uint8Array
    return [btoa(String.fromCharCode(...payload)), type + ';base64']
  }

  function decodePayload(content, type) {
    if (!type || type === 'application/json') { try { return JSON.parse(content) } catch { return content } }
    if (type.startsWith('text/')) return content
    if (type.endsWith(';base64')) return Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
    return content
  }

  /**
   * send({ payload, type?, channel?, to?, ephemeral?, replyTo?, schema? })
   *  - channel: { id } public · { id, sk } shared-key encrypted
   *  - to: recipient pubkey → NIP-44 direct encrypted
   */
  async function send({ payload, type, channel, to, ephemeral, replyTo, schema } = {}) {
    let [content, mime] = encodePayload(payload, type)
    const tags = [['m', mime]]
    if (schema) tags.push(['schema', schema])
    if (replyTo) tags.push(['e', replyTo])
    if (channel) {
      tags.push(['c', channel.id ?? channel])
      if (channel.sk) { // shared-key: encrypt to the channel's pubkey
        const chPk = (await agentKeys(channel.sk)).pk
        content = t.nip44.v2.encrypt(content, convKey(chPk))
        tags.push(['enc', 'nip44-channel'])
      }
    }
    if (to) {
      tags.push(['p', to])
      content = t.nip44.v2.encrypt(content, convKey(to))
      tags.push(['enc', 'nip44'])
    }
    const event = t.finalizeEvent({
      kind: ephemeral ? KIND_EPHEMERAL : KIND_MSG,
      created_at: Math.floor(Date.now() / 1000),
      tags, content,
    }, skBytes)
    await pool.publish(event)
    return event
  }

  /**
   * listen({ channel?, direct?, kinds?, includeSelf?, backlog? }, onMessage)
   * onMessage({ event, payload, type, from, channelId, reply })
   * Refractory rules built in: own events skipped (unless includeSelf),
   * duplicates dropped, undecryptables ignored.
   */
  function listen(opts, onMessage) {
    const { channel, direct, kinds = [KIND_MSG, KIND_EPHEMERAL], includeSelf = false, backlog = 0 } = opts
    const filter = { kinds, limit: backlog }
    if (channel) filter['#c'] = [channel.id ?? channel]
    if (direct) filter['#p'] = [pk]
    return pool.subscribe([filter], {
      onEvent: async (event) => {
        if (seen.has(event.id)) return
        seen.add(event.id)
        if (!includeSelf && event.pubkey === pk) return
        let content = event.content
        const enc = event.tags.find((x) => x[0] === 'enc')?.[1]
        try {
          if (enc === 'nip44-channel' && channel?.sk) {
            const chSk = hexToBytes(channel.sk)
            content = t.nip44.v2.decrypt(content, t.nip44.v2.utils.getConversationKey(chSk, event.pubkey))
          } else if (enc === 'nip44') {
            content = t.nip44.v2.decrypt(content, convKey(event.pubkey))
          } else if (enc) return // encrypted for someone else
        } catch { return }
        const mime = event.tags.find((x) => x[0] === 'm')?.[1]
        onMessage({
          event,
          payload: decodePayload(content, mime),
          type: mime,
          from: event.pubkey,
          channelId: event.tags.find((x) => x[0] === 'c')?.[1] ?? null,
          reply: (payload, extra = {}) => send({
            payload, channel, to: direct ? event.pubkey : undefined,
            replyTo: event.id, ...extra,
          }),
        })
      },
    })
  }

  return { pk, send, listen, pool, close: () => pool.close() }
}
