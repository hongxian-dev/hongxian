/**
 * 平台服务客户端测试（M1.3）——认证头 / 实例地址 / 注册与历史状态
 *
 * 纯逻辑 + 本地文件状态，不发任何 HTTP（HTTP 路径由 E2E 对真实服务端覆盖）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyMaterial, keyIdFromPublicKey, signDetached, verifyDetached } from '@hongxian/crypto';
import { canonicalBytes, fromBase64 } from '@hongxian/schema';
import {
  appendHistory,
  buildAuthHeaderValue,
  loadHistory,
  loadRegistration,
  normalizeInstanceUrl,
  saveRegistration,
} from '../src/server-client.js';
import { store } from '../src/context.js';

let home: string;
const prevHome = process.env.HONGXIAN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hx-mcp-cli-'));
  process.env.HONGXIAN_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HONGXIAN_HOME;
  else process.env.HONGXIAN_HOME = prevHome;
});

describe('buildAuthHeaderValue（协议 §7 无状态签名认证）', () => {
  it('格式为 opaque_id:ts:sig，且签名可通过卡自带公钥验真', () => {
    // 用真实 Ed25519 密钥对生成/校验（与服务端 verifyAuthHeader 同口径）
    const km = generateKeyMaterial();
    const opaqueId = Buffer.from(keyIdFromPublicKey(km.identityPublic)).toString('base64');
    const sign = (bytes: Uint8Array) => signDetached(bytes, km.identityPrivate);
    const now = 1_800_000_000_000;
    const header = buildAuthHeaderValue(opaqueId, 'GET /v2/mailbox/abc', sign, now);

    const parts = header.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(opaqueId);
    expect(parts[1]).toBe(String(Math.floor(now / 1000)));
    const sig = fromBase64(parts[2]!);
    const message = canonicalBytes({ opaque_id: opaqueId, ts: Math.floor(now / 1000), action: 'GET /v2/mailbox/abc' });
    expect(verifyDetached(sig, message, km.identityPublic)).toBe(true);
  });

  it('action 串参与签名——换端点签名即废（防跨端点重放）', () => {
    const km = generateKeyMaterial();
    const opaqueId = Buffer.from(keyIdFromPublicKey(km.identityPublic)).toString('base64');
    const sign = (bytes: Uint8Array) => signDetached(bytes, km.identityPrivate);
    const header = buildAuthHeaderValue(opaqueId, 'GET /v2/mailbox/abc', sign, 1_800_000_000_000);
    const [, ts, sigB64] = header.split(':') as [string, string, string];
    const wrong = canonicalBytes({ opaque_id: opaqueId, ts: Number(ts), action: 'DELETE /v2/mailbox/abc/xyz' });
    expect(verifyDetached(fromBase64(sigB64), wrong, km.identityPublic)).toBe(false);
  });
});

describe('normalizeInstanceUrl', () => {
  it('合法 http/https 地址去尾斜杠', () => {
    expect(normalizeInstanceUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizeInstanceUrl('https://plaza.example.com/base/')).toBe('https://plaza.example.com/base');
  });
  it('拒绝非 http 协议与畸形输入', () => {
    expect(normalizeInstanceUrl('ftp://x.com')).toBeNull();
    expect(normalizeInstanceUrl('not a url')).toBeNull();
    expect(normalizeInstanceUrl('')).toBeNull();
  });
});

describe('注册状态与历史记录（本地 JSON）', () => {
  it('注册记录读写往返', () => {
    const s = store();
    expect(loadRegistration(s)).toBeNull();
    const reg = { instance: 'http://localhost:8787', opaque_id: 'opaque', registered_at: new Date().toISOString() };
    saveRegistration(s, reg);
    expect(loadRegistration(s)).toEqual(reg);
  });

  it('历史记录追加 + 上限裁剪（保留最近）', () => {
    const s = store();
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    appendHistory(s, 'server/plaza-seen.json', ids);
    const hist = loadHistory(s, 'server/plaza-seen.json');
    expect(hist).toHaveLength(500);
    expect(hist[0]).toBe('id-100'); // 最旧 100 条被裁掉
    expect(hist[hist.length - 1]).toBe('id-599');
  });

  it('空追加不写文件', () => {
    const s = store();
    appendHistory(s, 'server/pulled.json', []);
    expect(loadHistory(s, 'server/pulled.json')).toEqual([]);
    expect(s.exists('server/pulled.json')).toBe(false);
  });
});
