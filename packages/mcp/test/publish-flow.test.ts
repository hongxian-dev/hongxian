/**
 * 发布许可 · 月老侧流程测试（C17 / D1 方案 B）
 *
 * 这里验的不是服务端（服务端有自己的 20 项），而是**月老对主人说了什么**。
 * 这一步的真实风险不是"接口调不通"，是月老把这件事说错——
 * 说成实名认证、说成必须做、或者说成"不验证就少了一些功能"（实际上是只有广场一项）。
 * 所以断言大多落在文案上，而且是刻意断言的：文案就是产品。
 *
 * HTTP 用 stub 替身（真实服务端由 server/test/publish.test.ts 与 E2E 覆盖）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signMatchCard } from '@hongxian/core';
import { Session } from '../src/session.js';
import { store } from '../src/context.js';
import { plazaPublishTool } from '../src/tools-plaza.js';

const INSTANCE = 'http://test.local';

const sampleL1 = {
  nickname: '阿泽',
  gender: 'male' as const,
  seeking: 'female' as const,
  age_attested: true as const,
  age_band: '26_30' as const,
  city: { code: '310100', name: '上海' },
  height_band: '171_175' as const,
  marital_status: 'never_married' as const,
  job_category: 'tech' as const,
  education_band: 'bachelor' as const,
  interests: ['outdoor', 'reading', 'food'],
  bio: '写代码也爬山',
  goal: 'marriage_oriented' as const,
  econ_signal: ['independent' as const],
};
const sampleL2 = {
  values_tags: [{ tag: 'family_first' as const, weight: 0.8 }],
  lifestyle: { sleep: 'normal', smoking: 'never', drinking: 'occasionally', exercise: 'regularly', social: 'medium' },
  family_view: { parents_relation: 'harmonious', childbearing: 'want', cohabit_with_parents: 'reluctant' },
  money_view: 'balanced',
  assets_brief: { house: 'not_yet', car: 'owned' },
  dealbreakers: [],
  values_qa: [
    { question: '理想的一天？', answer: '早起爬山下午写代码' },
    { question: '钱为什么吵架？', answer: '提前说好大额支出' },
    { question: '家是什么？', answer: '可以说累的地方' },
  ],
  partner_pref: '情绪稳定，愿意沟通',
};
const depth = { interview_rounds: 9, completeness: 0.7, model_tier: 'local' as const };

interface Req {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body: unknown };

let home: string;
let session: Session;
let requests: Req[];
let route: (req: Req) => Reply;
const prevHome = process.env.HONGXIAN_HOME;

/** 默认路由：healthz 要求验证且通道可用；注册成功；其余按测试覆盖 */
function defaultRoute(req: Req): Reply {
  if (req.url.endsWith('/healthz')) {
    return {
      status: 200,
      body: {
        ok: true,
        instance: 'test.local',
        publish: { required: true, available: true, verify_base: 'https://hongxian.dev/publish-verify/' },
      },
    };
  }
  // 防护三（C2③）：贴卡前必须先读到披露声明
  if (req.url.endsWith('/v2/publish/disclosure')) return { status: 200, body: DISCLOSURE };
  if (req.url.endsWith('/v2/identity/register')) return { status: 201, body: { registered: true } };
  return { status: 404, body: { error: 'not stubbed' } };
}

/** 服务端返回的披露声明（测试用固定版） */
const DISCLOSURE = {
  version: '1.0',
  full: '贴到广场，会多出一条连接。你得先看清楚。\n边界在哪：技术上不是"绝对不可能"。',
  brief: '贴广场需要验证邮箱；平台会保存一个与你假名关联的邮箱哈希。查看完整说明 →',
  ack_label: '我明白平台会保存一个与我假名关联的邮箱哈希',
  require_ack: true,
};

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
  home = mkdtempSync(join(tmpdir(), 'hx-mcp-publish-'));
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

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  session.lock();
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HONGXIAN_HOME;
  else process.env.HONGXIAN_HOME = prevHome;
});

function outOf(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

async function call(args: Record<string, unknown>) {
  return outOf(
    (await plazaPublishTool.handler(
      // disclosure_ack 默认给 true：这一组测的是 C17 的验证流程本身，
      // 披露声明的门闩另有专门的用例（见文件末尾「防护三」）
      { action: 'publish', server: INSTANCE, disclosure_ack: true, ...args } as never,
      session,
    )) as never,
  );
}

describe('verify：给出网页链接，并把这件事的性质说清楚', () => {
  it('生成 nonce 并给出带 n= 与 k= 的链接', async () => {
    const text = await call({ action: 'verify' });
    const nonce = session.settings().publish_nonce;
    expect(nonce).toBeTruthy();
    expect(nonce!).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(text).toContain(`?n=${nonce}`);
    expect(text).toContain('k=');
  });

  it('必须说清三件事：不是注册、不需要密码、不验证你是谁', async () => {
    const text = await call({ action: 'verify' });
    expect(text).toContain('不是注册');
    expect(text).toContain('不验证你是谁');
    expect(text).not.toContain('实名认证是必须');
  });

  it('必须给出"不想验证也完全没关系"的替代路径（否则等于变相强制）', async () => {
    const text = await call({ action: 'verify' });
    expect(text).toContain('不想验证也完全没关系');
    // 替代路径要具体列出来，不能只说"也可以不用"
    for (const path of ['出卡', '点对点投递', '比对', '见面']) expect(text).toContain(path);
  });

  it('必须提示垃圾箱与 8 位许可码怎么回填', async () => {
    const text = await call({ action: 'verify' });
    expect(text).toContain('垃圾箱');
    expect(text).toContain('Gmail');
    expect(text).toContain('8 位发布许可码');
    expect(text).toContain('action=claim');
  });

  it('实例不要求验证时，明确说"不用验证，直接贴"', async () => {
    route = (req) =>
      req.url.endsWith('/healthz')
        ? { status: 200, body: { ok: true, publish: { required: false, available: true, verify_base: null } } }
        : defaultRoute(req);
    const text = await call({ action: 'verify' });
    expect(text).toContain('不要求发布确认');
    expect(session.settings().publish_nonce).toBeUndefined();
  });

  it('要求验证但通道没配时，明确说这是运营方的问题、不是主人的问题', async () => {
    route = (req) =>
      req.url.endsWith('/healthz')
        ? { status: 200, body: { ok: true, publish: { required: true, available: false, verify_base: null } } }
        : defaultRoute(req);
    const text = await call({ action: 'verify' });
    expect(text).toContain('运营方的配置问题');
    expect(text).toContain('send_via_server');
  });
});

describe('claim：回填许可码', () => {
  it('没有进行中的验证时，让主人先重新 verify', async () => {
    const text = await call({ action: 'claim', permit: 'ABCD2345' });
    expect(text).toContain('action=verify');
    // 不应该白发一次请求
    expect(requests.some((r) => r.url.includes('/v2/publish/credential'))).toBe(false);
  });

  it('成功：PUT 携带 nonce 与许可码，成功后清掉本地 nonce', async () => {
    session.updateSettings({ publish_nonce: 'A'.repeat(22) });
    route = (req) => {
      if (req.method === 'PUT' && req.url.endsWith('/v2/publish/credential')) {
        return { status: 201, body: { verified: true, verified_at: '2026-10-24T12:00:00.000Z' } };
      }
      return defaultRoute(req);
    };
    const text = await call({ action: 'claim', permit: 'abcd-2345' });
    const put = requests.find((r) => r.method === 'PUT' && r.url.includes('/v2/publish/credential'));
    // 客户端已归一：去连字符、转大写（用户抄成 4-4 分段是常态）
    expect(put?.body).toEqual({ nonce: 'A'.repeat(22), permit: 'ABCD2345' });
    expect(text).toContain('可以贴卡');
    expect(session.settings().publish_nonce).toBeUndefined();
  });

  it('许可码抄错：指出 0/O、1/I/L 的混淆可能，而不是只说"失败"', async () => {
    session.updateSettings({ publish_nonce: 'A'.repeat(22) });
    route = (req) =>
      req.method === 'PUT'
        ? { status: 403, body: { error: '许可码不对', code: 'publish_permit_invalid' } }
        : defaultRoute(req);
    const text = await call({ action: 'claim', permit: 'ABCD2345' });
    expect(text).toContain('0/O/1/I/L');
    expect(text).toContain('10 分钟');
  });

  it('邮箱已被别人绑过：解释"一邮箱一身份"，并给出两条路', async () => {
    session.updateSettings({ publish_nonce: 'A'.repeat(22) });
    route = (req) =>
      req.method === 'PUT'
        ? { status: 409, body: { error: '已绑定', code: 'publish_carrier_already_bound' } }
        : defaultRoute(req);
    const text = await call({ action: 'claim', permit: 'ABCD2345' });
    expect(text).toContain('换一个邮箱');
    expect(text).toContain('解绑');
  });
});

describe('publish：被拒时给下一步，不是甩错误', () => {
  it('403 requires_verification → 指引里必须有 action=verify 与"不是实名认证"', async () => {
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, session.keyProvider());
    store().write(`cards/mine/${card.meta.card_id}.json`, card);
    route = (req) =>
      req.url.endsWith('/v2/cards')
        ? { status: 403, body: { error: '要先确认邮箱', code: 'publish_requires_verification' } }
        : defaultRoute(req);
    const text = await call({ action: 'publish' });
    expect(text).toContain('action=verify');
    expect(text).toContain('action=claim');
    expect(text).toContain('不是实名认证');
    // 关键：不能让主人以为"卡有问题"
    expect(text).toContain('不是你的卡有问题');
  });

  it('503 通道不可用 → 指出是实例侧问题，并指路点对点投递', async () => {
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, session.keyProvider());
    store().write(`cards/mine/${card.meta.card_id}.json`, card);
    route = (req) =>
      req.url.endsWith('/v2/cards')
        ? { status: 503, body: { error: '没配置发信通道', code: 'publish_verification_unavailable' } }
        : defaultRoute(req);
    const text = await call({ action: 'publish' });
    expect(text).toContain('配置问题');
    expect(text).toContain('send_via_server');
  });
});

describe('status：把"能不能贴卡"一次说清', () => {
  /** status 不自动注册（它只回答状态）——所以先造一条本地注册记录，模拟"已连过平台" */
  function seedRegistration() {
    store().write('server/registration.json', {
      instance: INSTANCE,
      opaque_id: session.keyIdB64,
      registered_at: new Date().toISOString(),
    });
  }

  it('未验证时明确提示还差一步', async () => {
    seedRegistration();
    route = (req) => {
      if (req.url.endsWith('/v2/publish/credential')) return { status: 200, body: { verified: false } };
      return defaultRoute(req);
    };
    const text = await call({ action: 'status' });
    expect(text).toContain('"publish_required": true');
    expect(text).toContain('"publish_verified": false');
    expect(text).toContain('action=verify');
  });

  it('已验证时不出现"还差一步"的催促', async () => {
    seedRegistration();
    route = (req) => {
      if (req.url.endsWith('/v2/publish/credential')) {
        return { status: 200, body: { verified: true, verified_at: '2026-10-24T12:00:00.000Z' } };
      }
      return defaultRoute(req);
    };
    const text = await call({ action: 'status' });
    expect(text).toContain('"publish_verified": true');
    expect(text).not.toContain('还差一步');
  });
});
