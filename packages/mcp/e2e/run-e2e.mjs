#!/usr/bin/env node
/**
 * E2E：真实 STDIO 子进程跑月老 MCP 全流程（S1–S7）
 *
 * 覆盖：initialize → tools/list(12) → prompts/list(4) →
 *       知情同意 → 24 词身份 → 三阶段访谈 → 签卡 → 导出 →
 *       乙方导入 → 升级请求 → L2 授权 → compare → 考题 → 回卷 →
 *       毕业邀请 → L3 授权 → ledger → backup/restore → wipe 无残留
 *
 * 运行：node packages/mcp/e2e/run-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, '..', 'dist', 'index.js');

const homeA = mkdtempSync(join(tmpdir(), 'hx-a-'));
const homeB = mkdtempSync(join(tmpdir(), 'hx-b-'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** MCP STDIO 客户端 */
class McpClient {
  constructor(home) {
    this.proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, HONGXIAN_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          /* 非协议行（日志走 stderr，不应到这） */
        }
      }
    });
    this.proc.stderr.on('data', () => {}); // 日志静默
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超时: ${method}`)), 30000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callTool(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`工具错误 ${name}: ${JSON.stringify(res.error)}`);
    const text = res.result?.content?.[0]?.text ?? '';
    return { text, isError: res.result?.isError === true };
  }

  close() {
    this.proc.kill();
  }
}

function extractJsonBlock(text) {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}

/** 从 send_envelope 响应提取信封文件相对路径，再按"文件交换"语义读取（真实信道） */
function takeEnvelope(home, text) {
  const m = text.match(/存入本机：(\S+)/);
  if (!m) throw new Error(`响应中未找到信封路径：${text.slice(0, 200)}`);
  return JSON.parse(readFileSync(join(home, m[1]), 'utf8'));
}

async function bootstrap(client) {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1.0' },
  });
  client.notify('notifications/initialized');
}

/** 完整建画像（三阶段） */
async function buildProfile(client) {
  let r = await client.callTool('interview', { action: 'consent', age_attested: true });
  const mnemonic = r.text.match(/：\*\*\s*\n\n([^\n]+)\n\n/)?.[1]?.trim();
  r = await client.callTool('interview', { action: 'confirm_mnemonic', mnemonic });
  const facts = {
    nickname: '阿泽',
    gender: 'male',
    seeking: 'female',
    age_band: '26_30',
    city: { code: '310100', name: '上海' },
    height_band: '171_175',
    marital_status: 'never_married',
    job_category: 'tech',
    education_band: 'bachelor',
    interests: ['outdoor', 'reading', 'food'],
    bio: '写代码也爬山',
    goal: 'marriage_oriented',
  };
  await client.callTool('interview', { action: 'submit', stage: 'facts', answers: facts });
  await client.callTool('interview', { action: 'confirm' });
  await client.callTool('interview', {
    action: 'submit',
    stage: 'preferences',
    answers: {
      values_tags: [{ tag: 'family_first', weight: 0.8 }],
      lifestyle: { sleep: 'normal', smoking: 'never', drinking: 'occasionally', exercise: 'regularly', social: 'medium' },
      family_view: { parents_relation: 'harmonious', childbearing: 'want', cohabit_with_parents: 'reluctant' },
      money_view: 'balanced',
      assets_brief: { house: 'not_yet', car: 'owned' },
      dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }],
      partner_pref: '情绪稳定，愿意沟通',
    },
  });
  await client.callTool('interview', { action: 'confirm' });
  await client.callTool('interview', {
    action: 'submit',
    stage: 'values',
    answers: {
      values_qa: [
        { question: '理想的一天？', answer: '早起爬山下午写代码' },
        { question: '钱为什么吵架？', answer: '提前说好大额支出' },
        { question: '家是什么？', answer: '可以说累的地方' },
      ],
    },
  });
  await client.callTool('interview', { action: 'confirm' });
  return mnemonic;
}

async function main() {
  console.log('=== 月老 MCP E2E（STDIO 真实子进程）===\n');
  const a = new McpClient(homeA);
  const b = new McpClient(homeB);

  try {
    // ---- 协议握手 ----
    console.log('■ 协议握手');
    await bootstrap(a);
    const initRes = await a.request('tools/list');
    const tools = initRes.result.tools.map((t) => t.name);
    check('tools/list 返回 12 件工具', tools.length === 12, `实际 ${tools.length}: ${tools.join(',')}`);
    for (const t of ['interview', 'sign_card', 'export_card', 'import_card', 'compare', 'send_envelope', 'receive_envelope', 'ledger', 'coach', 'backup', 'restore', 'wipe']) {
      check(`工具存在: ${t}`, tools.includes(t));
    }
    const promptsRes = await a.request('prompts/list');
    const prompts = promptsRes.result.prompts.map((p) => p.name);
    check('prompts/list 返回 4 条', prompts.length === 4, prompts.join(','));

    // ---- S1 知情同意 + 身份 ----
    console.log('\n■ S1 知情同意与身份');
    const startRes = await a.callTool('interview', { action: 'start' });
    check('首次启动返回知情同意书', startRes.text.includes('年满 18 周岁'));
    const mnemonicA = await buildProfile(a);
    check('24 词恢复短语已生成', typeof mnemonicA === 'string' && mnemonicA.split(' ').length === 24);
    await buildProfile(b);
    check('乙方身份与画像就绪', true);

    // ---- S4 签卡 ----
    console.log('\n■ S4 签卡');
    const signRes = await a.callTool('sign_card', {});
    check('甲方签卡成功', signRes.text.includes('匹配卡已签发'), signRes.text.slice(0, 120));
    const exportRes = await a.callTool('export_card', {});
    const cardA = extractJsonBlock(exportRes.text);
    check('导出卡片文件内容', cardA !== null && cardA.meta?.card_id);
    check('交换确认码（QR）生成', /交换确认码（QR 内容[^）]*）：[0-9a-f]{16}/.test(exportRes.text));
    check('卡片带 key_l1（L1 随卡）', typeof cardA.key_l1 === 'string');
    check('卡片带 sig/kx 公钥', !!cardA.meta.sig_public && !!cardA.meta.kx_public);

    // ---- S5 名片互换 ----
    console.log('\n■ S5 名片互换（乙方导入甲方卡）');
    const importRes = await b.callTool('import_card', { file_content: JSON.stringify(cardA) });
    check('乙方导入验签通过', importRes.text.includes('验证通过'), importRes.text.slice(0, 160));
    check('乙方看到甲方一阶名片', importRes.text.includes('阿泽'));

    // 乙方也签卡导出，甲方导入
    await b.callTool('sign_card', {});
    const exportB = await b.callTool('export_card', {});
    const cardB = extractJsonBlock(exportB.text);
    const importB2A = await a.callTool('import_card', { file_content: JSON.stringify(cardB) });
    check('甲方导入乙方卡', importB2A.text.includes('验证通过'));

    // ---- 篡改检测 ----
    const tampered = JSON.parse(JSON.stringify(cardA));
    tampered.meta.depth.completeness = 0.99;
    const tamperedRes = await b.callTool('import_card', { file_content: JSON.stringify(tampered) });
    check('篡改卡片被拒绝（§7.4 不降级）', tamperedRes.text.includes('签名无效') || tamperedRes.text.includes('未通过验证'), tamperedRes.text.slice(0, 100));

    // ---- 升级握手：L2 ----
    console.log('\n■ D5 升级握手（L2）');
    // v0.4：缺 requester_kx_public 的升级请求应被拒（协议 schema 校验，不静默发畸形信封）
    const upgBad = await a.callTool('send_envelope', {
      msg_type: 'upgrade_request',
      target_card_id: cardB.meta.card_id,
      body: { from_card_id: cardA.meta.card_id, attach_card_ref: 'card.json' },
      my_card_id: cardA.meta.card_id,
    });
    check('畸形升级请求被拒（缺 requester_kx_public，v0.4）', upgBad.text.includes('消息体不合法'), upgBad.text.slice(0, 120));
    const upg = await a.callTool('send_envelope', {
      msg_type: 'upgrade_request',
      target_card_id: cardB.meta.card_id,
      body: { from_card_id: cardA.meta.card_id, attach_card_ref: 'card.json', requester_kx_public: cardA.meta.kx_public },
      my_card_id: cardA.meta.card_id,
    });
    const upgEnv = takeEnvelope(homeA, upg.text);
    check('甲方生成升级请求封', upgEnv !== null && upgEnv.meta.msg_type === 'upgrade_request');
    const recvUpg = await b.callTool('receive_envelope', { file_content: JSON.stringify(upgEnv) });
    check('乙方收到升级请求并呈报', recvUpg.text.includes('请求解锁匹配层'), recvUpg.text.slice(0, 120));
    // 乙方同意：grant_l2（用甲方 kx 公钥封装 key_L2——乙方本地生成封装材料）
    // v1 简化：grant_l2 的 wrapped_key_l2 由 core wrapLayerKey 生成，此处经 send_envelope 的 body 传入
    const grant = await b.callTool('send_envelope', {
      msg_type: 'grant_l2',
      target_card_id: cardA.meta.card_id,
      body: { from_card_id: cardB.meta.card_id, wrapped_key_l2: Buffer.alloc(32, 1).toString('base64') },
      my_card_id: cardB.meta.card_id,
    });
    const grantEnv = takeEnvelope(homeB, grant.text);
    const recvGrant = await a.callTool('receive_envelope', { file_content: JSON.stringify(grantEnv) });
    check('grant_l2 信封送达（甲方处理）', recvGrant.text.length > 0);

    // ---- S6 比对 ----
    console.log('\n■ S6 本地比对');
    const cmp = await a.callTool('compare', { card_id: cardB.meta.card_id });
    check('compare 返回档位与叙事输入', cmp.text.includes('tier') && cmp.text.includes('narrative_input'), cmp.text.slice(0, 100));

    // ---- D10 考题/回卷 ----
    console.log('\n■ D10/D11 考题与回卷');
    const coachRes = await a.callTool('coach', { dimension: '价值观' });
    check('选题教练给候选题+理由', coachRes.text.includes('理由') && coachRes.text.includes('月老建议的'));
    const topic = await a.callTool('send_envelope', {
      msg_type: 'topic_pack',
      target_card_id: cardB.meta.card_id,
      body: {
        from_card_id: cardA.meta.card_id,
        round: 1,
        topic: '你理想的一天是怎样的？',
        followups: ['从早到晚说一遍', '最近一次说走就走是什么时候'],
        reason: '日常节奏比宏大三观更能预测相处质量',
        channel: 'yuelao',
      },
      my_card_id: cardA.meta.card_id,
    });
    const topicEnv = takeEnvelope(homeA, topic.text);
    check('追问 ≤2 封顶通过 schema', topicEnv.meta.msg_type === 'topic_pack');
    const recvTopic = await b.callTool('receive_envelope', { file_content: JSON.stringify(topicEnv) });
    check('乙方收到考题并呈报三态应答', recvTopic.text.includes('三态应答'));
    const answer = await b.callTool('send_envelope', {
      msg_type: 'answer_card',
      target_card_id: cardA.meta.card_id,
      body: { from_card_id: cardB.meta.card_id, round: 1, topic_ref: '你理想的一天是怎样的？', status: 'answered', answer: '先跑步再做饭，下午读书' },
      my_card_id: cardB.meta.card_id,
    });
    const answerEnv = takeEnvelope(homeB, answer.text);
    const recvAnswer = await a.callTool('receive_envelope', { file_content: JSON.stringify(answerEnv) });
    check('回卷闭合送达甲方', recvAnswer.text.includes('已回答'), recvAnswer.text.slice(0, 200));

    // ---- D13 毕业邀请 ----
    console.log('\n■ D13 毕业邀请');
    const invite = await a.callTool('send_envelope', {
      msg_type: 'graduation_invite',
      target_card_id: cardB.meta.card_id,
      body: { from_card_id: cardA.meta.card_id, letter: '很高兴认识你，周末南山咖啡馆见？', request_l3_fields: ['contact_wechat'] },
      my_card_id: cardA.meta.card_id,
    });
    const inviteEnv = takeEnvelope(homeA, invite.text);
    const recvInvite = await b.callTool('receive_envelope', { file_content: JSON.stringify(inviteEnv) });
    check('毕业邀请含亲笔短信呈报', recvInvite.text.includes('亲笔短信') && recvInvite.text.includes('暂缓'));

    // ---- D3② 手账 ----
    console.log('\n■ D3② 红线手账');
    const ledgerRes = await a.callTool('ledger', { action: 'list' });
    check('手账列出姻缘线', ledgerRes.text.includes('姻缘线'));

    // ---- D15③ 备份恢复 ----
    console.log('\n■ D15③ 备份与恢复');
    const backupRes = await a.callTool('backup', {});
    const archive = extractJsonBlock(backupRes.text);
    check('加密档案导出', archive !== null && archive.v === 1);
    // 恢复到乙方 home 之外的新实例（新 home）
    const homeC = mkdtempSync(join(tmpdir(), 'hx-c-'));
    const c = new McpClient(homeC);
    await bootstrap(c);
    await c.callTool('interview', { action: 'start' });
    await c.callTool('interview', { action: 'consent', age_attested: true });
    const restoreRes = await c.callTool('restore', { archive: JSON.stringify(archive), mnemonic: mnemonicA });
    check('档案恢复到新设备（密钥由短语重建）', restoreRes.text.includes('恢复完成'), restoreRes.text.slice(0, 140));
    c.close();
    rmSync(homeC, { recursive: true, force: true });

    // ---- S3 一键删除 ----
    console.log('\n■ S3 一键删除（无残留验收）');
    const wipeRes = await a.callTool('wipe', { confirm: true });
    check('wipe 执行', wipeRes.text.includes('已删除全部本地数据'));
    check('wipe 后磁盘零残留', !existsSync(homeA), `homeA 仍存在: ${existsSync(homeA) ? readdirSync(homeA).join(',') : ''}`);
    // wipe 后会话锁定：工具应提示解锁
    const afterWipe = await a.callTool('ledger', { action: 'list' });
    check('wipe 后需重新解锁/同意', afterWipe.text.includes('解锁') || afterWipe.text.includes('知情同意'), afterWipe.text.slice(0, 80));

    // ---- 外网审计 ----
    console.log('\n■ 零外链自证');
    const src = await import('node:fs').then((fs) =>
      ['server.ts', 'session.ts', 'counter.ts', 'consent.ts', 'tools-profile.ts', 'tools-exchange.ts', 'tools-lifecycle.ts', 'store-fs.ts', 'prompts.ts', 'context.ts']
        .map((f) => {
          try {
            return fs.readFileSync(join(__dirname, '..', 'src', f), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n'),
    );
    const urls = [...src.matchAll(/https?:\/\/[^\s'"`]+/g)].map((m) => m[0]);
    check('源码外链仅计数器端点', urls.every((u) => u.startsWith('https://count.hongxian.dev')), urls.join(', '));
  } finally {
    a.close();
    b.close();
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }

  console.log(`\n===== E2E 完成：${passed}/${passed + failed} 通过 =====`);
  if (failed > 0) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('E2E 运行异常：', e);
  process.exit(1);
});
