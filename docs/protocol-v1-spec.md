# Hongxian Protocol v1 (Spec)

> Machine-readable form: [`@hongxian/schema`](../packages/schema) (Zod).
> Status: **v1.2, public for review** (2026-10-22). Supersedes [protocol v0 draft](protocol-v0-spec.md).
> v1.1 change (non-breaking): the meeting layer (`payload_L3`) is a *sealed container* with per-field
> subkeys, and `grant_l3` may carry `container_key` — see §3.3. Readers must keep accepting the v1.0
> whole-layer shape.
> v1.2 change (non-breaking, opt-in): plaza cards may carry `declared_filters` — four coarse,
> self-declared retrieval conditions in plaintext meta (§2.1, §5). Plus anti-abuse reports (§6.1)
> and the anonymous instance aggregate (§6.2). Cards without `declared_filters` remain valid.
> License: [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — the protocol itself must stay open; the code is Apache-2.0.

---

## 0. What this protocol is

Hongxian Protocol v1 defines the **data format and channel semantics** for privacy-first
matchmaking between personal AI agents:

- the **Match Card** (three-tier encrypted envelope, two variants: direct-file and plaza),
- the **crypto envelope** format shared by all message types,
- the **message family** (nine original types + `grant_l1`),
- the **plaza flow** (discovery without a server-readable name card),
- the **mailbox semantics** (async delivery, pull-based, zero presence),
- the **addressing scheme** (opaque ID, federation-ready),
- the **key system** (identity / key-exchange / layer keys).

**What it is NOT**: no matching algorithm, no presence system, no ranking.
The post office discipline (不匹配、不排序、不评估、不推荐 — no matching, no ranking,
no scoring, no recommending) applies to every implementation, client and server alike.

**Versioning**: `schema_version` starts at `1`. Unknown fields MUST be ignored with a
warning (forward compatibility). v2-era features (plaza cards, decline receipts,
federation addressing) are **in the format from v1** — v1 → v2 requires zero migration
of cards or identities.

---

## 1. Design principles

1. **Three tiers = three independent encrypted payloads** — there is no "one plaintext card with permissions".
2. **Symmetry is a schema constraint** — layer-key exchange is structurally bidirectional (you cannot peek without giving).
3. **Private layer is field-by-field opt-in** — "give WeChat but not phone number" is a first-class case.
4. **Never collect**: government ID numbers, exact addresses (below neighborhood level), exact income figures, chat logs. No field exists at any tier.
5. **Weak-model friendly** — controlled vocabularies dominate; free text is length-capped; cards carry a **depth marker** so counterpart agents can flag low confidence.
6. **Server-zero-knowledge by construction** — a server only ever sees `card_id + public keys + ciphertext + TTL`. This is now a **hard rule, not an aspiration**: §2.2 splits the `key_l1` carriage rule by card variant precisely so that no server ever holds material that decrypts any tier.
7. **Async by default** — no party ever needs to be online at the same time. Presence and read receipts are prohibited at the protocol level (no field exists), because silence is a signal the protocol must not leak.

---

## 2. Card envelope structure

A Match Card is one JSON file with two variants:

```
MatchCardEnvelope
├── meta         plaintext metadata (readable by anyone)
├── key_l1       base64 — L1 layer key. DIRECT variant only (see §2.2)
├── payload_L1   AES-256-GCM ciphertext (key_L1)
├── payload_L2   AES-256-GCM ciphertext (key_L2)
├── payload_L3   AES-256-GCM sealed container (containerKey, see §3.3; optional)
└── signature    Ed25519 over canonical(meta ‖ [key_l1] ‖ payload_L1 ‖ payload_L2 ‖ [payload_L3])
```

### 2.1 meta fields

| Field | Type | Constraint | Notes |
|---|---|---|---|
| `schema_version` | int | `1` | forward-compatible: unknown fields ignored + warned |
| `card_id` | UUIDv7 | globally unique | opaque, contains no identity |
| `owner_key_id` | base64 | 32-byte fingerprint | SHA-256(signing public key); not an identity |
| `sig_public` | base64 | 32-byte Ed25519 public key | signature verification (see §2.3) |
| `kx_public` | base64 | 32-byte X25519 public key | recipient key for grant envelopes |
| `version` | int | monotonic | re-sign invalidates older versions |
| `created_at` / `expires_at` | ISO 8601 | TTL default 30 days | renewal required after expiry |
| `card_type` | enum | `match_card` / `plaza_card` | selects the `key_l1` rule (§2.2) |
| `depth` | object | required | `interview_rounds`, `completeness` (0–1), `model_tier` (`local`/`cloud`) |
| `introducer_sig` | optional | **@deprecated** (v0.5 removal) | introducer chain retired 2026-10-20 (D8: declared circles only) |
| `declared_filters` | optional | **plaza_card only** | coarse self-declared conditions that become public: `gender`, `seeking`, `city` (6-digit GB/T 2260), `age_band`, `visible_to` (`all`/`same_city`/`same_age_band`). Signed like every other meta field; an empty object is invalid. See §5.1 |
| `algo` | object | fixed | `{"sig":"ed25519","aead":"aes-256-gcm","kex":"x25519"}` |

### 2.2 key_l1 — carriage rule split by variant (v1 hard rule)

**`match_card` (direct-file variant, v1 introducer-chain exchange):** `key_l1` travels
with the card. Tier-1 content is *public by design* between the two parties who exchange
the file; encrypting it costs nothing and keeps the three-tier format uniform. Whoever
holds the file can decrypt L1.

**`plaza_card` (plaza variant, server-relayed):** `key_l1` MUST NOT be present.
A plaza card is stored and forwarded by a server; if the L1 key traveled with the blob,
the server could decrypt tier 1 — violating principle 6. The schema enforces this
(`plaza_card` + `key_l1` = invalid envelope).

Because the signature covers `meta` (including `card_type`), downgrading a `match_card`
to a `plaza_card` by stripping `key_l1` fails verification — only the owner can issue
either variant, and both are the owner's explicit choice.

### 2.3 Trust model for public keys

`sig_public` / `kx_public` ride in the card metadata. Public keys are public cryptography
parameters, not identity. Trust = TOFU (first use) + optional `introducer_sig`
endorsement. **Signature verification failure = whole card void, no degradation** (§10.4).

---

## 3. Payload field tables

Unchanged from v0; reproduced for completeness.

All enum fields accept `unspecified` (unanswered is a legal value).

### 3.1 L1 · Name-card layer (public)

`nickname`(≤20) · `gender` · `seeking` · `age_attested`(must be `true`; ≥18 legal requirement) · `age_band` · `city`{GB/T 2260 6-digit code, name} · `height_band` · `marital_status` · `job_category` · `education_band` · `interests`(≤5, controlled) · `bio`(≤100) · `goal` · `econ_signal`(multi-select life-state — **not** income figures).

### 3.2 L2 · Matching layer (deep-chat)

`values_tags`(≤8, tag+weight) · `lifestyle`(sleep/smoking/drinking/exercise/social) · `family_view` · `money_view`(5 bands) · `assets_brief`(house/car) · `income_band`(optional, wide bands) · `dealbreakers`(≤5) · `values_qa`(3–5 Q&A ≤200 chars each — the quote evidence for reports) · `partner_pref`(≤150).

### 3.3 L3 · Meeting layer (private, per-field opt-in)

`contact_wechat` · `contact_phone` · `real_name` · `employer_category` · `hangout_areas`(≤5) · `photo_refs` — **photos never enter the card**: only hash + decryption key of the local encrypted file; originals travel separately.

**Per-field sealing (v1.1).** The meeting layer is not one opaque blob: it is a *sealed container* so
that a grant can release one field without releasing the rest ("give WeChat, keep the phone number").

```
payload_L3 = Enc(containerKey, JSON{ v:1, fields:{ <field>: CipherBlock } })

containerKey  = HKDF-SHA256(layerKey_L3, info="hongxian/protocol/v1/subkey/l3/container")
fieldKey(f)   = HKDF-SHA256(layerKey_L3, info="hongxian/protocol/v1/subkey/l3/<field>")
```

- Each `CipherBlock` is AES-256-GCM under its own `fieldKey` — fields are independent.
- `containerKey` opens the outer layer only: a holder gets the *set of field ciphertexts* and
  nothing readable. Releasing `containerKey` therefore leaks **the list of field names, not values**.
- `layerKey_L3` itself is `.gitignore`-level material: it never leaves the owner's device, except in
  the v1.0 whole-layer grant path (`container_key` omitted ⇒ outer layer was sealed with it directly).
- Unknown field names are rejected at seal time (whitelist above) — a card cannot smuggle extra keys.
- Readers must tolerate both shapes: `{v,fields}` (v1.1) and a plain object (v1.0 bare text).

---

## 4. Message family

Same envelope format, distinguished by `msg_type`; all travel the handshake channel:

| Type | Direction | Payload | Decision |
|---|---|---|---|
| `match_card` | both | tier-1 card (L1 visible; L2/L3 ciphertext carried) | D5/D8 |
| `card_renewal` | both | re-signed card (version+1) | D3 |
| `upgrade_request` | one-way | request unlock, attaches own card + `requester_kx_public` | D5/D8 |
| `grant_l1` | one-way | plaza tier-1 unlock: `card_fingerprint` + `sealed_key_l1` | **v1 new** |
| `grant_l2` | one-way | key_L2 sealed to recipient's X25519 public key | D5 |
| `topic_pack` | one-way | exam pack: 1 topic + ≤2 follow-ups, with reason + channel | D10/D11 |
| `answer_card` | one-way | structured answer / ask-master / deferred | D10 |
| `graduation_invite` | one-way | optional handwritten letter + L3 field requests | D13 |
| `grant_l3` | one-way | per-field opt-in: `container_key` (outer layer only) + `fields:[{field, wrapped_key}]` | D13 |
| `decline_silent` | one-way | fixed content only, zero side channel — v2 (v1 uses silence) | D4 |

`upgrade_request` in the **plaza flow** requests tier-1 unlock (the requester holds the
plaza card ciphertext but not `key_l1`); in the **direct flow** it requests L2 as before.
The semantic difference is which layer the subsequent grant delivers — the message body
is identical, and `requester_kx_public` is what makes the sealed reply possible.

**Round discipline (D11)**: one topic + at most 2 follow-ups per round (anti-interrogation);
symmetric questioning rights; every round returns to the owner's decision: continue /
graduate / let go.
**Graduation discipline**: when consecutive rounds yield no new information and no
dealbreaker hits, the agent honestly suggests "graduate (meet) or let go" — no infinite
pen-palling.

---

## 5. Plaza flow (discovery, zero-knowledge)

The plaza is a **dumb pipe**. The server stores and serves plaza cards; it filters nothing,
ranks nothing, and reads nothing.

```
1. UPLOAD    owner's Yuelao signs a plaza_card variant (no key_l1) → server stores
             { meta, payload_L1, payload_L2, [payload_L3] } + TTL
2. BROWSE    any Yuelao pulls the pool (cursor pagination) → verifies signatures,
             sees ONLY meta + ciphertext + TTL. There is no readable name card.
3. KNOCK     interested party sends upgrade_request (directed, to owner's opaque ID),
             carrying requester_kx_public
4. DECIDE    owner's Yuelao presents the request; the owner decides: respond or stay silent
5. UNLOCK    on respond: grant_l1 envelope — key_l1 sealed to requester_kx_public
             (X25519 sealed box). Requester decrypts L1 locally.
```

Design notes:

- **Step 2 is intentionally austere.** Discovery shows that someone exists and matches
  nothing; the name card is earned by asking, not by browsing. This is the ladder
  philosophy (tier-by-tier opt-in) applied to strangers.
- **No filtering parameter exists in the API.** The server never accepts a query that
  sorts, ranks or narrows the pool. Circle selection happens entirely on the client,
  over `declared_filters` (§5.1) — "coarse bucketing is the allowed limit, and v2.0
  keeps it out of the server" (constitution §3).
- **Silence is a complete answer.** No delivery receipt beyond "entered the mailbox",
  no read receipt, no presence. The owner may simply not respond — the protocol makes
  that indistinguishable from never having seen the request, by design (D4).

### 5.1 declared_filters — declared circles without server bucketing

Discovery by strangers needs *some* coarse narrowing: "same city / same age band / the
direction I'm looking for". But L1 is ciphertext, so before `grant_l1` a browsing client
knows nothing to narrow by. Two options existed:

| Option | Verdict |
|---|---|
| Server-side bucketing on plaintext filters | ✗ turns the post office into a matching desk (D8, principle: pull not push) |
| **Client-side bucketing on *self-declared* plaintext** | ✓ adopted (v1.2) |

`declared_filters` therefore holds **only what the owner chooses to publish** — not
profile content:

- `gender` / `seeking` — the direction pair; both sides check reciprocally (A sees B
  only if A wants B's gender *and* B wants A's), so a one-way peek is not expressible.
- `city` — 6-digit GB/T 2260 city code; the city, never the district or address.
- `age_band` — same controlled vocabulary as L1.
- `visible_to` — circle B ("who may see me"). `same_city` / `same_age_band` mean a
  browser that cannot confirm the match is not shown the card at all.

Rules:

1. The field lives in `meta` and is **covered by the signature** — a server or third
   party cannot rewrite someone's declared scope without breaking verification.
2. `match_card` MUST NOT carry it (direct-file cards have no circle consumers).
3. Filtering is **client-side only**. The server still returns the whole pool.
4. Honest limit: `visible_to` is enforced by cooperating clients, not by the server.
   A modified client can ignore someone's visibility declaration — but it still cannot
   read a single byte of their name card without `grant_l1`.

---

## 6. Mailbox semantics

| Rule | Value | Rationale |
|---|---|---|
| Delivery | directed only — recipient = one opaque ID; broadcast is not expressible | anti-harassment by structure |
| Confirmation to sender | "entered the mailbox" — nothing about recipient activity | no side channels |
| Retrieval | pull with cursor; client-driven, no push, no notification from server | async-first (principle 7) |
| Retention | 30 days default, then automatic server-side deletion; recipient may delete immediately | minimal server holding |
| Rate limit | ≤20 directed deliveries per opaque ID per day (initial value) | structural anti-abuse |
| Card limit | 1 active plaza card per opaque ID (re-sign overwrites) | anti-sockpuppet via signature chain |

The mailbox holds ciphertext and opaque IDs only. A server operator cannot read, rank,
or match content even under legal compulsion short of key possession — which it never has.

### 6.1 Anti-abuse reports (behaviour signals, never content)

Zero knowledge has a structural cost: the server **cannot review content**, so it cannot
adjudicate a complaint either. The protocol is honest about that and limits reports to
what a server can legitimately know:

```
POST /v2/reports          { target_opaque_id, reason_code }   (signed by reporter)
GET  /v2/reports/:id      → { reports, distinct, flagged }     (signed by the target)
```

| Rule | Value | Rationale |
|---|---|---|
| `reason_code` | closed enum: `harassment` / `spam` / `fraud_suspicion` / `impersonation` / `other` | free text would turn reports into a content-review channel |
| Reporter identity | salted pseudonym `SHA-256(instance_secret \| opaque_id)`, never the raw ID | dedupe possible, "who reported whom" not recoverable from a stolen data directory |
| Counting | distinct reporters only; N=3 distinct sets `flagged` | one person cannot flag someone by repetition |
| Who can read a summary | the target only | a public report count becomes a shaming tool |
| Effect of `flagged` | "worth an operator's look" — throttling/banning is an instance decision | the protocol never adjudicates; federation is the user's exit |
| Self-report / unknown target | rejected (400 / 404) | — |

### 6.2 Anonymous instance aggregate (transparency)

```
GET /v2/stats  → { identities, cards, envelopes, reported_targets, flagged_targets, generated_at, instance }
```

Totals only: no opaque IDs, no per-user activity, no content, no ranking. Same discipline
as the v1 counter page — publish what can be published, publish nothing that identifies
anyone.

---

## 7. Addressing and federation

```
address = opaque_id["@" instance]
opaque_id  = base64(32-byte Ed25519 public-key fingerprint)
instance   = DNS name of a mailbox/plaza instance
```

- **v1/v2.0 (single instance):** the `@instance` suffix is ignored; `opaque_id` alone
  addresses a mailbox. The field is reserved, not absent — clients and servers MUST
  accept and preserve it.
- **v2.1 (federation):** envelopes route cross-instance by suffix (email-like). Instance
  trust policy is deliberately unspecified here — federation is a social problem before
  it is a protocol problem.

Identity is the keypair. Moving instances never changes identity; the Yuelao client
exports/imports via the same encrypted-archive mechanism as key backup.

---

## 8. Controlled vocabularies v0.1

Unchanged from v0: interests (12), values_tags (8), dealbreaker dimensions (8),
job_category (8). Deliberately minimal at first (D10 "few but precise").

---

## 9. Key system

| Key | Algorithm | Storage | Use |
|---|---|---|---|
| Identity keypair | Ed25519 | private key never leaves the device in plaintext | signs cards and all envelopes |
| Key-exchange | X25519 | public key in card metadata | "exchange card = exchange public key"; grants seal layer keys to the recipient's public key |
| Layer keys L1/L2/L3 | AES-256-GCM | generated locally; L1 key carriage per §2.2 | independent per-tier encryption; grants deliver **keys only**, never decrypted payloads |

**Recovery phrase = identity**: BIP39 24-word (Chinese simplified) → Argon2id
(t=3, m=64MB, p=4) → master key → HKDF domain-separated derivation of identity seed /
kx seed / layer keys. The same phrase deterministically rebuilds the same identity on a
new device. The `keys/*.enc` files are a local performance cache, not the source of truth.

**Plaza rule (v1 hard):** `key_l1` never travels to a server (§2.2). Every other layer
key has always been delivered only inside sealed grant envelopes.

---

## 10. Validation and fault tolerance (hard rules)

1. LLM-generated cards MUST pass schema validation; ≤3 retries, then fall back to human confirmation (no silent field dropping).
2. Unknown fields are ignored **with a warning** (forward compatibility).
3. Cards with `depth.completeness < 0.6` MUST be flagged in counterpart reports: "insufficient profile depth — limited confidence".
4. **Signature verification failure = whole card void. No degradation.**
5. **`plaza_card` carrying `key_l1` is invalid at the schema level** — implementations MUST reject it before upload (server) and before signature verification (client). This is the machine-enforced form of principle 6.

---

## 11. Backward-compatibility reserved slots

| Reserved slot | Intended use | v1 behavior |
|---|---|---|
| `meta.v2_scope_declaration` | plaza scope declaration (v2 D8④) | unknown field → ignored + warned |
| `meta.v2_federation_hint` | federated instance routing (v2.1) | ignored + warned |
| `payload_L2.v2_dealbreaker_weights` | learned dealbreaker weights (v3 private dashboard) | ignored + warned |
| `Address.instance` | federation routing suffix (§7) | accepted + preserved, routing ignored until v2.1 |

Any future field added under these slots MUST follow the §10.2 rule.

---

## 12. Changelog

- **v0 draft (2026-10-19)**: first public draft. Envelope structure, three-tier fields, nine message types, key system, validation rules, reserved slots.
- **v1.2 (2026-10-22)**: declared circles without server bucketing — `declared_filters` in plaintext meta on plaza cards only (§2.1, §5.1), reciprocal direction check, signature-covered. Anti-abuse reports on behaviour signals with salted reporter pseudonyms (§6.1). Anonymous instance aggregate (§6.2). All additive: v1.0/v1.1 cards remain valid.
- **v1 (2026-10-19)**: platform-service layer formalized. `key_l1` carriage split by card variant (plaza cards carry none — zero-knowledge hard rule, §2.2/§10.5); `grant_l1` message and the plaza flow (§5); mailbox semantics (§6); `opaque_id@instance` addressing with federation reserved (§7); `upgrade_request` gains required `requester_kx_public`. Message family is now nine + `grant_l1`.
