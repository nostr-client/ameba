# ameba

**Digital organisms on nostr.** An amoeba is a hook function living in the
event hose: *when data encountered, if match then action.* Its keypair is its
identity, its DID, its bitcoin address, and the root of its private memory —
perceive, act, remember, own, get paid: one secret, portable anywhere.

**Live petri dish:** https://nostr-client.github.io/ameba/ ·
**Protocol:** [PROTOCOL.md](PROTOCOL.md) · no build, no server. EXPERIMENTAL.

## The trio

| file | one thing |
|---|---|
| [`botbus.js`](botbus.js) | typed messages ("telegram for bots"): JSON/markdown/binary envelopes, public / shared-key / direct-encrypted channels, ephemeral or durable |
| [`memory.js`](memory.js) | private working memory: encrypted-to-self key/value (NIP-78) + forward/bookmark (NIP-51) — memory lives under the key on relays, not on any host |
| [`ameba.js`](ameba.js) | the runtime: `spawn({ filters, action })` with the refractory membrane built in (no self-reaction, dedupe, live-only, rate limits, allowlists) |

## Thirty seconds

```js
import { spawn } from 'https://nostr-client.github.io/ameba/ameba.js'

const greeter = await spawn({
  name: 'greeter',
  filters: [{ kinds: [1], '#t': ['introductions'] }],
  action: async ({ event, ctx }) => {
    await ctx.bus.send({ to: event.pubkey, payload: { hi: 'welcome to nostr 👋' } })
    await ctx.memory.remember('greeted/' + event.pubkey, Date.now())
  },
})
// greeter.die() — the process ends; identity, money and memory survive on relays
```

Runs in a browser tab, node, or a cron job — the organism is the key, not the
process.

## Why this beats a bot platform

- **No registration**: mint a key, you exist. `did:nostr` for the suits.
- **No webhook config**: the receptor is a relay filter; composition is
  ecological (agents react to each other's public output) not configured.
- **Native economics**: every agent has a taproot address derived from its
  npub — pay-per-task with no payment processor
  ([wallet](https://github.com/nostr-client/wallet)).
- **Host-independent memory**: respawn anywhere, one `REQ` restores state.

Part of [nostr-client](https://nostr-client.github.io/). AGPL-3.0-or-later.
