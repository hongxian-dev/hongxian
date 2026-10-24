/**
 * 三条防护 · 月老侧测试（C2 / D7）
 *
 * 服务端侧在 packages/server/test/safety.test.ts；这里测的是**月老说了什么、拦在哪一步**：
 *   防护一 风险提示 —— 未确认不得建画像；确认只存版本与时间；文案改版要重看
 *   防护二 举报即断 —— 回执必须说"立即生效"与"双向"，且不许暗示平台会裁决
 *   防护三 披露声明 —— 贴卡前必须先看到全文，且文案来自服务端（本地不硬编码）
 *
 * HTTP 全部 stub，不碰真实网络。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFETY_ACK_LABEL, SAFETY_NOTICE_TEXT } from '@hongxian/core';
import { Session } from '../src/session.js';
import { store } from '../src/context.js';
import { interviewTool } from '../src/tools-profile.js';
import { plazaPublishTool, reportAbuseTool } from '../src/tools-plaza.js';

const INSTANCE = 'http://safety.test';

interface Req {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body: unknown };

const DISCLOSURE = {
  version: '1.0',
  full: '贴到广场，会多出一条连接。你得先看清楚。\n\n边界在哪：技术上不是"绝对不可能"。',
  brief: '贴广场需要验证邮箱；平台会保存一个与你假名关联的邮箱哈希。查看完整说明 →',
  ack_label: '我明白平台会保存一个与我假名关联的邮箱哈希',
  require_ack: true,
};

let home: string;
let session: Session;
let requests: Req[];
let route: (req: Req) => Reply;
const prevHome = process.env.HONGXIAN_HOME;

function defaultRoute(req: Req): Reply {
  if (req.url.endsWith('/healthz')) {
    return {
      status: 200,
      body: { ok: true, publish: { required: true, available: true, verify_base: 'https://hongxian.dev/publish-verify/' } },
    };
  }
  if (req.url.endsWith('/v2/publish/disclosure')) return { status: 200, body: DISCLOSURE };
  if (req.url.endsWith('/v2/identity/register')) return { status: 201, body: { registered: true } };
  if (req.url.endsWith('/v2/reports')) {
    return { status: 201, body: { recorded: true, immediate_block: true, summary: { reports: 1, distinct: 1, flagged: false } } };
  }
  return { status: 404, body: { error: 'not stubbed' } };
}

function installFetch() {
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string } = {}) => {
    const req: Req = {
      method: init.method ?? 'GET',
      url: String(url),
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    requests.push(req);
    const out = route(req);
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'hx-mcp-safety-'));
  process.env.HONGXIAN_HOME = home;
  session = new Session();
  await session.initIdentity();
});

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  requests = [];
  route = defaultRoute;
  installFetch();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  session.lock();
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HONGXIAN_HOME;
  else process.env.HONGXIAN_HOME = prevHome;
});

function outOf(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

async function interview(action: string) {
  return outOf((await interviewTool.handler({ action } as never, session)) as never);
}

async function publish(args: Record<string, unknown> = {}) {
  return outOf(
    (await plazaPublishTool.handler({ action: 'publish', server: INSTANCE, ...args } as never, session)) as never,
  );
}

async function reportAbuseStub() {
  return outOf(
    (await reportAbuseTool.handler(
      { action: 'file', server: INSTANCE, target_opaque_id: 'AAAABBBBCCCC', reason_code: 'fraud_suspicion' } as never,
      session,
    )) as never,
  );
}

// ---------- 防护一 ----------

describe('防护一 · 首次使用风险提示', () => {
  it('全新环境第一次进门 → 返回全文，并且不是错误（可继续的中间态）', async () => {
    const text = await interview('start');
    expect(text).toContain(SAFETY_NOTICE_TEXT);
    expect(text).toContain(`[ ] ${SAFETY_ACK_LABEL}`);
    expect(text).toContain('interview(action="ack")');
    expect(text).toContain('不是报错');
  });

  it('未确认前，任何进画像的动作都被拦（submit 也拿不到数据）', async () => {
    const text = await interview('submit');
    expect(text).toContain(SAFETY_NOTICE_TEXT);
  });

  it('unlock 不被拦——只解锁已有身份，不产生任何新数据', async () => {
    const text = await interview('unlock');
    expect(text).not.toContain(SAFETY_NOTICE_TEXT);
    expect(text).toContain('恢复短语');
  });

  it('确认之后转进知情同意（顺序：先知道会出什么事，再决定要不要开始）', async () => {
    const text = await interview('ack');
    expect(text).toContain('风险提示已确认');
    // 下一步直接给知情同意全文，不让用户自己去猜该调什么
    expect(text).toContain('在开始之前');
    expect(text).toContain('interview(action="consent"');
  });

  it('确认后不再重复展示，且记录只存版本与时间（不含任何身份信息）', async () => {
    await interview('ack');
    const text = await interview('start');
    expect(text).not.toContain(SAFETY_NOTICE_TEXT);

    const raw = readFileSync(join(home, 'safety-ack.json'), 'utf-8');
    const rec = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(['acked_at', 'version']);
    expect(rec.version).toBe('1.0');
    expect(raw).not.toMatch(/opaque|public|key|seed|mnemonic/i);
  });

  it('文案改版（本地记录版本落后）→ 重新展示全文', async () => {
    await interview('ack');
    store().write('safety-ack.json', { version: '0.9', acked_at: new Date().toISOString() });
    const text = await interview('start');
    expect(text).toContain(SAFETY_NOTICE_TEXT);
  });
});

// ---------- 防护三 ----------

describe('防护三 · 贴卡前披露声明', () => {
  it('第一次 verify 不带 disclosure_ack → 停下来把全文给你读', async () => {
    const text = await publish({ action: 'verify' });
    expect(text).toContain(DISCLOSURE.full);
    expect(text).toContain(DISCLOSURE.ack_label);
    expect(text).toContain('disclosure_ack=true');
    expect(session.settings().publish_nonce).toBeUndefined();
  });

  it('不带 ack 的那次也不该生成 nonce（否则等于先放了行再补话）', async () => {
    await publish({ action: 'verify' });
    expect(session.settings().publish_nonce).toBeUndefined();
    expect(requests.some((r) => r.url.includes('/v2/publish/otp'))).toBe(false);
  });

  it('带上 disclosure_ack=true → 放行并记下版本', async () => {
    const text = await publish({ action: 'verify', disclosure_ack: true });
    expect(text).not.toContain(DISCLOSURE.full);
    expect(text).toContain('action=claim');
    expect(session.settings().publish_disclosure_version).toBe('1.0');
    expect(session.settings().publish_nonce).toBeTruthy();
  });

  it('第二次及以后：一行缩略提示，不再全文', async () => {
    await publish({ action: 'verify', disclosure_ack: true });
    const text = await publish({ action: 'verify' });
    expect(text).not.toContain(DISCLOSURE.full);
    expect(text).toContain(DISCLOSURE.brief);
  });

  it('声明改了版本 → 必须重新读（版本号不一致就要重看）', async () => {
    await publish({ action: 'verify', disclosure_ack: true });
    route = (req) =>
      req.url.endsWith('/v2/publish/disclosure') ? { status: 200, body: { ...DISCLOSURE, version: '1.1' } } : defaultRoute(req);
    const text = await publish({ action: 'verify' });
    expect(text).toContain(DISCLOSURE.full);
  });

  it('取不到声明 → 不放行（丑话不能靠"服务端连不上"这条缝溜过去）', async () => {
    route = (req) =>
      req.url.endsWith('/v2/publish/disclosure') ? { status: 500, body: { error: 'boom' } } : defaultRoute(req);
    const text = await publish({ action: 'verify', disclosure_ack: true });
    expect(text).toContain('读不到实例的披露声明');
    expect(text).toContain('先不放行');
    expect(session.settings().publish_nonce).toBeUndefined();
  });

  it('实例不要求验证（自托管私有）时不弹披露声明——它不收邮箱，讲了才是假话', async () => {
    route = (req) =>
      req.url.endsWith('/healthz')
        ? { status: 200, body: { ok: true, publish: { required: false, available: true, verify_base: null } } }
        : defaultRoute(req);
    const text = await publish({ action: 'verify' });
    expect(text).toContain('不要求发布确认');
    expect(text).not.toContain(DISCLOSURE.full);
  });
});

// ---------- 防护二（回执文案） ----------

describe('防护二 · 举报回执必须说清"立即生效"与"双向"', () => {
  it('回执第一句就是"立即生效"，并说清这条线断了', async () => {
    const text = await reportAbuseStub();
    expect(text).toContain('已收到');
    expect(text).toContain('立即生效');
    expect(text).toContain('不能再向你投递');
  });

  it('说明双向闭合（否则用户会以为"只有他发不过来"）', async () => {
    const text = await reportAbuseStub();
    expect(text).toContain('双向');
    expect(text).toContain('你也发不到他那里');
  });

  it('不越权承诺：明说平台不会自动封禁、不会摘卡', async () => {
    const text = await reportAbuseStub();
    expect(text).toContain('不会自动封禁');
    expect(text).toContain('也不会把他的卡从广场摘掉');
    expect(text).toContain('不会公开指认');
  });

  it('给动作而不是给道德：96110 / 110 / 保留证据', async () => {
    const text = await reportAbuseStub();
    expect(text).toContain('96110');
    expect(text).toContain('110');
    expect(text).toContain('保留证据');
  });

  it('明确"举报不需要理由，也不需要证据"（不给受害者加举证负担）', async () => {
    const text = await reportAbuseStub();
    expect(text).toContain('不需要理由');
    expect(text).toContain('不需要证据');
  });
});
