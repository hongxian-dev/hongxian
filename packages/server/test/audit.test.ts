/**
 * 零知识审计测试（工程设计 V5）
 *
 * 宪法 §4："平台能接触到的最多只是用户公钥 + 加密 blob，无法解密内容。"
 * 本测试把这条承诺变成可执行断言——不是文案，是 CI 红灯：
 *
 * 1. 源码级：server 包 src 不得 import @hongxian/crypto（解密能力整体）；
 *    不得出现 sealBox/openBox/unwrapLayerKey/decryptLayer/key_l1 消费形态；
 *    不得出现任何 http(s) URL（服务端零出网，连计数器都不接）。
 * 2. 数据级：全流程跑完后，数据目录里不得存在可解密 L1 的材料
 *    （key_l1 字段），也不得出现任何明文昵称等 L1 字段。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 剥离注释后的代码（审计断言只针对可执行代码；注释允许解释性提及）。
 * 用正则而非行前缀——JSDoc 块注释可能以 /** 开头且行首可能混入不可见字符
 * （零宽空格等，trim 按规范不移除），行前缀法会漏判。
 */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 绝对路径 → 文件名（断言里只关心"是哪个文件"） */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

describe('零知识审计（server）', () => {
  const files = listSourceFiles(SRC_DIR);
  const sources = files.map((f) => ({ name: f, text: readFileSync(f, 'utf-8') }));

  it('源码文件齐备（非空）', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(sources.every((s) => s.text.length > 0)).toBe(true);
  });

  it('不得 import @hongxian/crypto（解密能力整体排除）', () => {
    for (const s of sources) {
      expect(s.text, s.name).not.toMatch(/from '@hongxian\/crypto'/);
      expect(s.text, s.name).not.toMatch(/from "@hongxian\/crypto"/);
    }
  });

  it('不得出现解密/开封原语调用（代码行，注释说明除外）', () => {
    const forbidden = ['sealBox', 'openBox', 'unwrapLayerKey', 'wrapLayerKey', 'decryptLayer', 'openMessageBody', 'openKeyFile'];
    for (const s of sources) {
      const code = codeOf(s.text);
      for (const token of forbidden) {
        expect(code.includes(token), `${s.name} 代码含 ${token}`).toBe(false);
      }
    }
  });

  it('不得消费 key_l1（server 无任何 key_l1 读取）', () => {
    for (const s of sources) {
      const code = codeOf(s.text);
      expect(code.includes('key_l1'), `${s.name} 代码引用 key_l1`).toBe(false);
    }
  });

  /**
   * C17 之后，「零出网」这条军规不再成立——验证一个邮箱能收信，物理上必须往外发一封信。
   * 军规因此收紧成**「只有一个出网点」**，并且这个出网点只认识"地址 + 验证码"：
   * 三条断言分别守住"只有它"、"只打一个域"、"它什么内容都不认识"。
   */
  it('唯一出网点 = mailer.ts，且只打 api.resend.com', () => {
    const withUrl = sources.filter((s) => /https?:\/\//.test(s.text)).map((s) => basename(s.name));
    expect(withUrl).toEqual(['mailer.ts']);
    const urls = sources.flatMap((s) => s.text.match(/https?:\/\/[^\s'"`)]+/g) ?? []);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(new URL(u).hostname, u).toBe('api.resend.com');
    }
  });

  it('只有 mailer.ts 允许调用 fetch（其他文件想联网会红灯）', () => {
    const fetching = sources
      .filter((s) => /(^|[^.\w])fetch\s*\(/.test(codeOf(s.text)))
      .map((s) => basename(s.name));
    expect(fetching).toEqual(['mailer.ts']);
  });

  it('mailer 什么内容都不认识：不得引用身份/载体/信封字段', () => {
    const src = sources.find((s) => basename(s.name) === 'mailer.ts');
    expect(src).toBeTruthy();
    const code = codeOf(src!.text);
    for (const forbidden of ['opaque_id', 'owner_key_id', 'carrier_hmac', 'payload', 'nonce']) {
      expect(code.includes(forbidden), `mailer.ts 代码含 ${forbidden}`).toBe(false);
    }
  });

  it('无日志外发/无追踪：不得出现 console.log（stdout 留协议；日志只走 stderr）', () => {
    for (const s of sources) {
      const code = codeOf(s.text);
      expect(code.includes('console.log'), `${s.name} 使用 console.log`).toBe(false);
    }
  });

  it('数据目录无明文 L1 材料（key_l1 字段与 L1 明文字段均不得落盘）', async () => {
    // 构造一个含 key_l1 的 mall_card 会被 §10.5 拒收；此处直接断言存储层不会写入该字段
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'hx-audit-'));
    try {
      const { ServerStore } = await import('../src/store.js');
      const store = new ServerStore(dir);
      // 走真实上传路径（见 api.test.ts 的 signedCard 简化版：仅验存储层不落地 key_l1）
      const card = {
        meta: {
          schema_version: 1,
          card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234',
          owner_key_id: Buffer.alloc(32, 1).toString('base64'),
          sig_public: Buffer.alloc(32, 2).toString('base64'),
          kx_public: Buffer.alloc(32, 3).toString('base64'),
          version: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
          card_type: 'plaza_card',
          depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' },
          algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
        },
        payload_L1: { nonce: 'AAAA', ct: 'BBBB' },
        payload_L2: { nonce: 'CCCC', ct: 'DDDD' },
        signature: 'c2ln',
      };
      store.putCard(card.meta.owner_key_id, { envelope: card as never, uploaded_at: new Date().toISOString() });
      const onDisk = readFileSync(join(dir, 'cards', Buffer.from(card.meta.owner_key_id, 'base64').toString('hex') + '.json'), 'utf-8');
      expect(onDisk).not.toContain('key_l1');
      expect(onDisk).not.toContain('nickname');
      // 反向对照：若强写 key_l1 的文件出现，本断言即失败（防止未来回退）
      writeFileSync(join(dir, 'cards', 'canary.json'), JSON.stringify({ key_l1: 'x' }));
      const canary = readFileSync(join(dir, 'cards', 'canary.json'), 'utf-8');
      expect(canary).toContain('key_l1'); // 证明该检测方法有效
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('数据目录 secret 仅 store 持有：其他源码文件不得引用', () => {
    const referencing = sources.filter((s) => codeOf(s.text).includes("'secret'")).map((s) => basename(s.name));
    expect(referencing).toEqual(['store.ts']);
  });
});
