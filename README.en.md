# HONGXIAN · Yuelao

> **Outsource the process of matchmaking — never your own heartbeat.**

Yuelao is an open-source tool (an MCP server) that lives on your own device. Inside your Agent it handles the repetitive, awkward, time-consuming parts — building a profile, exchanging cards, comparing locally, drafting question packs. But you read the reports, you decide whether to meet, and the heartbeat stays yours.

It does not matchmake, rank, evaluate, or recommend. No servers, no accounts, no "you might also like".

- Data stays on your device (`~/.hongxian/`, one command to erase completely)
- Card exchange costs zero tokens (pure local cryptography, milliseconds)
- LLM costs are split symmetrically (use your own model — fair for both sides)
- Works offline (the only optional network call is an opt-in anonymous counter, off by default)

---

## Get started in three steps (≤ 15 minutes, from zero to your first match card)

**1. Install** (pick whichever fits your host)

```bash
# Generic: run via npx (Node 20+)
npx @hongxian/mcp
```

Host configuration example (wiring Yuelao into your Agent):

```jsonc
// Claude Desktop / WorkBuddy / any standard MCP host — mcpServers config
{
  "mcpServers": {
    "yuelao": {
      "command": "npx",
      "args": ["-y", "@hongxian/mcp"]
    }
  }
}
```

**2. Talk with Yuelao three times** (15–20 minutes each, spread over days is fine)

Say to your Agent: "open Yuelao". It first shows you a consent page (what is collected, where it is stored, how to delete it, and the fact that conversations pass through the model you configured — the ugly parts up front). After you confirm, it generates your 24-word recovery phrase. Then three sessions: hard facts → preferences & lifestyle → values stories. After each session Yuelao recaps "the you I understand is…" — it only writes to the profile once you nod.

**3. Sign a match card and hand it over**

Say to your Agent: "sign a match card". Yuelao assembles a three-layer encrypted card (public / matching / private layers with independent keys + Ed25519 signature), shows you a preview of exactly what the other side will see, and after confirmation exports a `.hongxian-card` file. You agree on how to transfer the file (in person / chat / email); the other side imports it the same way — signature verification, TTL check, then each of you compares locally and gets a five-tier report.

> Deeper conversations (question packs, answer cards), graduation invitations (unlocking the meet-in-person layer), and reviews all happen in this structured channel. Yuelao and Yuelao only shake hands — they never chitchat.

---

## Trust checklist (five self-checks)

| # | What to check | How |
|---|---|---|
| 1 | **Read the source** | Fully open source: [schema](../packages/schema), [crypto](../packages/crypto), [core](../packages/core), [mcp](../packages/mcp). No bundling obfuscation; the build is a single `tsc` step. |
| 2 | **Sniff the traffic** | The only possible outbound call is the optional anonymous counter (off by default). With it off, outbound traffic is zero. Offline, everything except the counter works fully. |
| 3 | **Verify hashes** | Every Release ships `SHA256SUMS.txt`: `sha256sum -c SHA256SUMS.txt`. npm packages carry fixed provenance (build origin is verifiable). |
| 4 | **One-command deletion** | Say to your Agent: "Yuelao, delete all my data" (the `wipe` tool). The entire data directory is erased with no disk residue — uninstall equals erase, because there is no server. |
| 5 | **(v2) Self-hosting** | The v2 messaging service will support federated self-hosting — the platform having no capacity for misbehavior is the mathematical foundation of trust. |

---

## FAQ

**Is this a dating agency?**
No. No matchmakers, no human involvement, no matchmaking service. Yuelao is your own tool; all matching computation happens locally. We will never provide matchmaking services, nor charge any fee related to matchmaking.

**Where is my data stored?**
On your device (`~/.hongxian/`). You can drop the whole directory into your own cloud drive for multi-device sync; move to a new device and rebuild the same identity from the 24-word recovery phrase. We have no servers, so there is nothing to leak.

**How do you charge?**
We don't. Open source (Apache-2.0), free forever. Operating costs are covered by voluntary support in the footer sponsorship area, physically isolated from product functionality.

**What will the other side see?**
The public layer: nickname, age band, city, marital status, broad occupation, interest tags, one-line intro, goal statement, self-described living situation (a life-state tag, not an income number). The matching and private layers travel encrypted with the card; without both parties' consent they cannot be opened. Plaintext already handed over cannot be remotely revoked — this is stated up front (the honest boundary of a peer-to-peer architecture).

**Is it safe?**
Cards and every envelope are Ed25519-signed (forgery is rejected), three layers use independent AES-256-GCM keys, layer keys are wrapped with X25519 public keys (a relay only ever sees ciphertext). The recovery phrase = Argon2id → all keys; plaintext keys never touch disk. Anti-fraud by design: three-stage symmetric exchange (a "take-but-never-give" scammer gets nowhere) + the private layer auto-attaches a final anti-fraud check.

**Is there a mobile app?**
Not yet. Two hard blockers: no local filesystem in apps, and no self-installable MCP. Desktop-class Agent tools (see the compatibility matrix below) are the v1 target.

**Is AI-generated content labeled?**
Reports and cards prominently state "profile content is self-reported by the user and not verified by any platform". v1 is private conversation and does not trigger public-disclosure labeling duties; v2, if public sharing (anniversary cards) is supported, will follow the labeling rules for AI-generated content.

---

## Protocol & docs

- [Protocol spec v0 (draft)](docs/protocol-v0-spec.md) — match card format, encrypted envelopes, nine message types (CC-BY-SA 4.0)
- [Host compatibility matrix](docs/host-compatibility.md) — verified hosts
- [Install & trust guide](docs/install-and-trust.md) — install troubleshooting, data directory, deletion & backup
- [schema package](packages/schema) — the machine-readable form of protocol v0 (standalone npm: `@hongxian/schema`)
- Design docs (Chinese): [positioning statement](../红线项目定位声明.md), [interaction design](../月老Skill交互设计方案.md), [technical design](../技术详设.md)

## License

Code [Apache-2.0](LICENSE) · Protocol docs [CC-BY-SA 4.0](docs/protocol-v0-spec.md)

---

*A thousand-mile marriage is tied by a single red thread. From today on, that thread is in your own hands.*
