# Hongxian Protocol v0 (Draft Spec)

> Machine-readable form: [`@hongxian/schema`](../packages/schema) (Zod).
> Status: **v0 draft, public for review** (2026-10-19).
> License: [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — the protocol itself must stay open; the code is Apache-2.0.

---

## 0. What this protocol is

Hongxian Protocol v0 defines the **data format** for privacy-first matchmaking between personal AI agents:

- the **Match Card** (three-tier encrypted envelope),
- the **crypto envelope** format shared by all message types,
- the **nine message types** of the handshake channel,
- the **key system** (identity / key-exchange / layer keys).

**What it is NOT**: no server behavior, no matching algorithm, no presence system.
The post office discipline (不匹配、不排序、不评估、不推荐 — no matching, no ranking, no scoring, no recommending) applies to every implementation.

**Versioning**: `schema_version` starts at `1`. Unknown fields MUST be ignored with a warning (forward compatibility). v2 features (plaza cards, decline receipts, federation) are reserved in the format from day one — **v1 → v2 requires zero migration**.

---

## 1. Design principles

1. **Three tiers = three independent encrypted payloads** — there is no "one plaintext card with permissions".
2. **Symmetry is a schema constraint** — layer-key exchange is structurally bidirectional (you cannot peek without giving).
3. **Private layer is field-by-field opt-in** — "give WeChat but not phone number" is a first-class case.
4. **Never collect**: government ID numbers, exact addresses (below neighborhood level), exact income figures, chat logs. No field exists at any tier.
5. **Weak-model friendly** — controlled vocabularies dominate; free text is length-capped; cards carry a **depth marker** so counterpart agents can flag low confidence.
6. **Server-zero-knowledge by construction** — a server only ever sees `card_id + public keys + ciphertext + TTL`.

---

## 2. Envelope structure

A Match Card is one JSON file:

```
MatchCardEnvelope
├── meta         plaintext metadata (readable by anyone)
├── key_l1       base64 — L1 layer key, carried in the clear (see §2.2)
├── payload_L1   AES-256-GCM ciphertext (key_L1)
├── payload_L2   AES-256-GCM ciphertext (key_L2)
├── payload_L3   AES-256-GCM ciphertext (key_L3, optional as a whole)
└── signature    Ed25519 over canonical(meta ‖ key_l1 ‖ payload_L1 ‖ payload_L2 ‖ payload_L3)
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
| `card_type` | enum | `match_card` / `plaza_card`(v2) | |
| `depth` | object | required | `interview_rounds`, `completeness` (0–1), `model_tier` (`local`/`cloud`) |
| `introducer_sig` | optional | introducer signature | trust weighting for the introducer chain |
| `algo` | object | fixed | `{"sig":"ed25519","aead":"aes-256-gcm","kex":"x25519"}` |

### 2.2 key_l1 — the open layer is encrypted too

`key_l1` travels **in the clear** with the card (protocol decision, 2026-10-14).
Tier-1 (name card) content is *public by design*; encrypting it costs nothing,
keeps the three-tier format uniform, and means a plaza scraper gets ciphertext,
not structured data. Any card holder can decrypt L1.

### 2.3 Trust model for public keys

`sig_public` / `kx_public` ride in the card metadata (engineering note: the v0.3
field table omitted them, but §6 requires "exchange public keys with the card").
Public keys are public cryptography parameters, not identity. Trust = TOFU
(first use) + optional `introducer_sig` endorsement. **Signature verification
failure = whole card void, no degradation** (§7.4).

---

## 3. Payload field tables

All enum fields accept `unspecified` (unanswered is a legal value, distinct from "declined to answer").

### 3.1 L1 · Name-card layer (public)

`nickname`(≤20) · `gender` · `seeking` · `age_attested`(must be `true`; ≥18 legal requirement) · `age_band` · `city`{GB/T 2260 6-digit code, name} · `height_band` · `marital_status` · `job_category` · `education_band` · `interests`(≤5, controlled) · `bio`(≤100) · `goal` · `econ_signal`(multi-select life-state: `undisclosed`/`independent`/`home_owner`/`home_owner_no_mortgage`/`car_owner` — **not** income figures).

### 3.2 L2 · Matching layer (deep-chat)

`values_tags`(≤8, tag+weight) · `lifestyle`(sleep/smoking/drinking/exercise/social) · `family_view`(parents relation / childbearing intent / cohabit intent) · `money_view`(5 bands) · `assets_brief`(house/car, independent) · `income_band`(optional, wide bands) · `dealbreakers`(≤5, dimension+note) · `values_qa`(3–5 Q&A ≤200 chars each — the quote evidence for reports) · `partner_pref`(≤150).

### 3.3 L3 · Meeting layer (private, whole-layer optional)

`contact_wechat` (default on) · `contact_phone` (off) · `real_name` (off) · `employer_category` (off, category only) · `hangout_areas` (≤5, to shopping-district level) · `photo_refs` (off — **photos never enter the card**: only hash + decryption key of the local encrypted file; originals travel separately).

---

## 4. Message type family (nine types)

Same envelope format, distinguished by `msg_type`; all travel the handshake channel:

| Type | Direction | Payload | Decision |
|---|---|---|---|
| `match_card` | both | tier-1 card (L1 visible; L2/L3 ciphertext carried) | D5/D8 |
| `card_renewal` | both | re-signed card (version+1) | D3 |
| `upgrade_request` | one-way | request L2 unlock, attaches own card | D5/D8 |
| `grant_l2` | one-way | key_L2 sealed to recipient's X25519 public key | D5 |
| `topic_pack` | one-way | exam pack: 1 topic + ≤2 follow-ups, with reason + channel | D10/D11 |
| `answer_card` | one-way | structured answer / ask-master / deferred | D10 |
| `graduation_invite` | one-way | optional handwritten letter + L3 field requests | D13 |
| `grant_l3` | one-way | per-field opt-in key delivery | D13 |
| `decline_silent` | one-way | fixed content only, zero side channel — **v2** (v1 uses silence) | D4 |

**Round discipline (D11)**: one topic + at most 2 follow-ups per round (anti-interrogation);
symmetric questioning rights; every round returns to the owner's decision: continue / graduate / let go.
**Graduation discipline**: when consecutive rounds yield no new information and no dealbreaker hits,
the agent honestly suggests "graduate (meet) or let go" — no infinite pen-palling.

---

## 5. Controlled vocabularies v0.1

Deliberately minimal at first (D10 "few but precise"), extended by version:

- **interests** (12): outdoor / sports / reading / film_tv / music / food / travel / gaming / handcraft / pets / photography / self_growth
- **values_tags** (8): family_first / career_driven / life_balance / free_explore / stability / open_to_new / traditional / spiritual_growth
- **dealbreaker dimensions** (8): smoking / drinking / childbearing / long_distance / pets / debt / religion / other
- **job_category** (8): tech / product_design / professional_service / public_sector / business_owner / skilled_trade / freelance / other

---

## 6. Key system

| Key | Algorithm | Storage | Use |
|---|---|---|---|
| Identity keypair | Ed25519 | private key never leaves the device in plaintext | signs cards and all envelopes |
| Key-exchange | X25519 | public key in card metadata | "exchange card = exchange public key"; all directed envelopes seal layer keys to the recipient's public key |
| Layer keys L1/L2/L3 | AES-256-GCM | generated locally, L1 carried in the clear | independent per-tier encryption; grant envelopes deliver **keys only**, never decrypt payloads |

**Recovery phrase = identity** (2026-10-19 engineering decision): BIP39 24-word
(Chinese simplified) → Argon2id (t=3, m=64MB, p=4) → master key → HKDF domain-separated
derivation of identity seed / kx seed / layer keys. The same phrase deterministically
rebuilds the same identity on a new device — old signatures verify, old grants decrypt,
existing lines continue. The `keys/*.enc` files are a local performance cache, not the
source of truth.

v1: everything local, no online components. v2: same format on the plaza — the server
holds `card_id + public keys + ciphertext + TTL` only; zero-knowledge holds by construction.

---

## 7. Validation and fault tolerance (hard rules)

1. LLM-generated cards MUST pass schema validation; ≤3 retries, then fall back to human confirmation (no silent field dropping).
2. Unknown fields are ignored **with a warning** (forward compatibility).
3. Cards with `depth.completeness < 0.6` MUST be flagged in counterpart reports: "insufficient profile depth — limited confidence".
4. **Signature verification failure = whole card void. No degradation.**

---

## 8. Backward-compatibility reserved slots

At least three reserved example slots for future extension (v1 cards must not break):

| Reserved slot | Intended use | v1 behavior |
|---|---|---|
| `meta.v2_scope_declaration` | plaza scope declaration (v2 D8④) | unknown field → ignored + warned |
| `meta.v2_federation_hint` | federated instance routing (v2.1) | ignored + warned |
| `payload_L2.v2_dealbreaker_weights` | learned dealbreaker weights (v3 private dashboard) | ignored + warned |

Any future field added under these slots MUST follow the §7.2 rule.

---

## 9. Changelog

- **v0 draft (2026-10-19)**: first public draft. Envelope structure, three-tier fields, nine message types, key system, validation rules, reserved slots. Engineering notes added for `sig_public`/`kx_public` (metadata key exchange) and `key_l1` clear carriage — both required by the v0.3 schema decisions and the reference implementation.
