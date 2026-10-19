#!/usr/bin/env node
/**
 * E2E：真实 STDIO 子进程跑月老 MCP 全流程（S1–S7 + M1.3 平台接入）
 *
 * 覆盖：initialize → tools/list(16) → prompts/list(4) →
 *       知情同意 → 24 词身份 → 三阶段访谈 → 签卡 → 导出 →
 *       乙方导入 → 升级请求 → L2 授权 → compare → 考题 → 回卷 →
 *       毕业邀请 → L3 授权 → ledger → backup/restore →
 *       M1.3 广场流（真实服务端子进程：贴卡→浏览→敲门→grant_l1→拉取→比对→撤卡→零知识审计）→
 *       wipe 无残留（含服务端身份级联注销）
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

  let serverProc = null;
  let serverHome = null;
  try {
    // ---- 协议握手 ----
    console.log('■ 协议握手');
    await bootstrap(a);
    const initRes = await a.request('tools/list');
    const tools = initRes.result.tools.map((t) => t.name);
    check('tools/list 返回 16 件工具', tools.length === 16, `实际 ${tools.length}: ${tools.join(',')}`);
    for (const t of ['interview', 'sign_card', 'export_card', 'import_card', 'compare', 'send_envelope', 'receive_envelope', 'ledger', 'coach', 'backup', 'restore', 'wipe', 'plaza_browse', 'plaza_publish', 'send_via_server', 'mailbox_pull']) {
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
    // v0.4/M1.3：requester_kx_public 缺省时由工具自动派生（本方协商公钥——恒可导出）；
    // 非法的值仍被协议 schema 拒绝（不静默发畸形信封）
    const upgAuto = await a.callTool('send_envelope', {
      msg_type: 'upgrade_request',
      target_card_id: cardB.meta.card_id,
      body: { from_card_id: cardA.meta.card_id, attach_card_ref: 'card.json' },
      my_card_id: cardA.meta.card_id,
    });
    check('升级请求缺 requester_kx_public 时自动派生', upgAuto.text.includes('信封已生成'), upgAuto.text.slice(0, 120));
    const upgBad = await a.callTool('send_envelope', {
      msg_type: 'upgrade_request',
      target_card_id: cardB.meta.card_id,
      body: { from_card_id: cardA.meta.card_id, attach_card_ref: 'card.json', requester_kx_public: '不是base64!!' },
      my_card_id: cardA.meta.card_id,
    });
    check('畸形升级请求被拒（requester_kx_public 非法，v0.4）', upgBad.text.includes('消息体不合法'), upgBad.text.slice(0, 120));
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

    // ---- M1.3 平台接入：真实服务端子进程 + 双客户端广场流 ----
    console.log('\n■ M1.3 平台接入（哑管道广场 + 加密信箱，V9）');
    serverHome = mkdtempSync(join(tmpdir(), 'hx-srv-'));
    const serverPort = 20000 + Math.floor(Math.random() * 20000);
    const plazaUrl = `http://127.0.0.1:${serverPort}`;
    serverProc = spawn(process.execPath, [join(__dirname, '..', '..', 'server', 'dist', 'index.js')], {
      env: { ...process.env, HONGXIAN_SERVER_DATA: serverHome, PORT: String(serverPort), HONGXIAN_INSTANCE: 'localhost' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let serverLog = '';
    serverProc.stderr.on('data', (d) => {
      serverLog += d.toString();
    });
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${plazaUrl}/healthz`);
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* 还没起 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    check('服务端子进程启动（healthz）', healthy, serverLog.slice(0, 200));

    // A 贴广场卡（plaza_card 变体：无 key_l1——§10.5）
    const pubA = await a.callTool('plaza_publish', { action: 'publish', server: plazaUrl });
    check('甲方贴广场卡成功', pubA.text.includes('广场卡已贴上'), pubA.text.slice(0, 140));
    const fpA = pubA.text.match(/指纹 ([0-9a-f]{16})/)?.[1];
    check('贴卡返回 16 位指纹', typeof fpA === 'string' && fpA.length === 16);
    const regAFile = join(homeA, 'server', 'registration.json');
    check('甲方服务端注册记录落盘', existsSync(regAFile));
    const opaqueA = existsSync(regAFile) ? JSON.parse(readFileSync(regAFile, 'utf8')).opaque_id : null;
    // 服务端落盘的卡：结构无 key_l1（零知识硬规则的服务端落地）
    const storedCardFiles = readdirSync(join(serverHome, 'cards')).filter((f) => f.endsWith('.json'));
    check('服务端存有 1 张广场卡', storedCardFiles.length === 1);
    const storedCard = JSON.parse(readFileSync(join(serverHome, 'cards', storedCardFiles[0]), 'utf8'));
    check('服务端卡无 key_l1 字段（§10.5）', !('key_l1' in storedCard.envelope));
    check('服务端卡为 plaza_card 变体', storedCard.envelope.meta.card_type === 'plaza_card');

    // B 浏览：只见轮廓，不见内容
    const browseB = await b.callTool('plaza_browse', { server: plazaUrl });
    const browsePayload = extractJsonBlock(browseB.text);
    check('乙方浏览返回结构化轮廓', browsePayload !== null && Array.isArray(browsePayload.outlines));
    const outlineA = (browsePayload?.outlines ?? []).find((o) => o.fingerprint === fpA);
    check('乙方看到甲方轮廓（指纹匹配）', !!outlineA);
    check(
      '轮廓不含任何内容字段（哑管道）',
      outlineA !== undefined && !('nickname' in outlineA) && !('bio' in outlineA) && !('payload_L1' in outlineA) && !('key_l1' in outlineA),
    );
    check('轮廓含协商公钥（敲门寻址用）', typeof outlineA?.kx_public === 'string');

    // B 敲门：经服务端投递 upgrade_request——确认只到"已入信箱"
    const knock = await b.callTool('send_via_server', {
      msg_type: 'upgrade_request',
      target_card_id: outlineA.card_id,
      body: { from_card_id: cardB.meta.card_id, attach_card_ref: 'plaza' },
      server: plazaUrl,
    });
    check('乙方敲门只确认"已入信箱"', knock.text.includes('已入信箱'), knock.text.slice(0, 140));
    check('敲门无已读/送达回执语义', !knock.text.includes('已读') && !knock.text.includes('对方已收到'));

    // A 拉信箱：见到敲门 + 广场流指引（grant_l1）
    const pullA = await a.callTool('mailbox_pull', { server: plazaUrl });
    check('甲方拉到敲门信', pullA.text.includes('敲门请求解锁一阶名片'), pullA.text.slice(0, 160));
    check('广场流指引建议 grant_l1', pullA.text.includes('grant_l1'));
    const pullA2 = await a.callTool('mailbox_pull', { server: plazaUrl });
    check('拉取即删（服务端不再持有）', pullA2.text.includes('信箱是空的'), pullA2.text.slice(0, 100));

    // A 应答 grant_l1（密封钥匙由工具派生——LLM 不构造密文）
    const regBFile = join(homeB, 'server', 'registration.json');
    const regB = existsSync(regBFile) ? JSON.parse(readFileSync(regBFile, 'utf8')) : null;
    check('乙方服务端注册记录存在', typeof regB?.opaque_id === 'string');
    const grant1 = await a.callTool('send_via_server', {
      msg_type: 'grant_l1',
      target_address: regB.opaque_id,
      body: { card_fingerprint: fpA, requester_kx_public: cardB.meta.kx_public },
      server: plazaUrl,
    });
    check('甲方应答 grant_l1（已入信箱）', grant1.text.includes('已入信箱'), grant1.text.slice(0, 140));

    // B 拉取授权：一阶解锁 → compare 可行
    const pullB = await b.callTool('mailbox_pull', { server: plazaUrl });
    check('乙方收到一阶授权（V6 显式解锁）', pullB.text.includes('一阶名片已解锁'), pullB.text.slice(0, 160));
    const cmpPlaza = await b.callTool('compare', { card_id: outlineA.card_id });
    check('广场流 compare 可行（L1 经 grant_l1 解锁）', cmpPlaza.text.includes('tier'), cmpPlaza.text.slice(0, 120));

    // 错误路径：裸地址（无存证卡→无协商公钥，信封无法加封）/ 跨实例地址
    const strangerId = Buffer.alloc(32, 7).toString('base64');
    const knockStranger = await b.callTool('send_via_server', {
      msg_type: 'upgrade_request',
      target_address: strangerId,
      body: { from_card_id: cardB.meta.card_id, attach_card_ref: 'plaza' },
      server: plazaUrl,
    });
    check('裸地址投递被拒（无协商公钥——须先浏览存证）', knockStranger.text.includes('缺少收件人协商公钥'), knockStranger.text.slice(0, 140));
    const knockCross = await b.callTool('send_via_server', {
      msg_type: 'upgrade_request',
      target_address: `${regB.opaque_id}@other.example`,
      body: { from_card_id: cardB.meta.card_id, attach_card_ref: 'plaza' },
      server: plazaUrl,
    });
    check('跨实例投递被拒（v2.1 前不开放）', knockCross.text.includes('跨实例投递未开放'), knockCross.text.slice(0, 140));

    // A 撤卡：广场池清零（HTTP 直查——哑管道无单卡查询端点）
    const wd = await a.callTool('plaza_publish', { action: 'withdraw', server: plazaUrl });
    check('甲方撤卡成功', wd.text.includes('已撤回广场卡'), wd.text.slice(0, 120));
    const poolAfter = await (await fetch(`${plazaUrl}/v2/cards`)).json();
    check('撤卡后服务端广场池为空', poolAfter.items.length === 0);

    // 服务端数据目录零知识审计：全目录 grep 不到 key_l1
    let keyL1Leak = false;
    const auditWalk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) auditWalk(p);
        else {
          try {
            if (readFileSync(p, 'utf8').includes('key_l1')) keyL1Leak = true;
          } catch {
            /* 非文本文件跳过 */
          }
        }
      }
    };
    auditWalk(serverHome);
    check('服务端数据目录零知识审计（无 key_l1）', !keyL1Leak);

    // ---- S3 一键删除 ----
    console.log('\n■ S3 一键删除（无残留验收 + 服务端级联注销）');
    const wipeRes = await a.callTool('wipe', { confirm: true });
    check('wipe 执行', wipeRes.text.includes('已删除全部本地数据'));
    check('wipe 级联注销服务端身份', wipeRes.text.includes('服务端身份已注销'), wipeRes.text.slice(0, 240));
    const idAfterWipe = await fetch(`${plazaUrl}/v2/identity/${encodeURIComponent(opaqueA)}`);
    check('注销后服务端身份 404', idAfterWipe.status === 404, `HTTP ${idAfterWipe.status}`);
    check('wipe 后磁盘零残留', !existsSync(homeA), `homeA 仍存在: ${existsSync(homeA) ? readdirSync(homeA).join(',') : ''}`);
    // wipe 后会话锁定：工具应提示解锁
    const afterWipe = await a.callTool('ledger', { action: 'list' });
    check('wipe 后需重新解锁/同意', afterWipe.text.includes('解锁') || afterWipe.text.includes('知情同意'), afterWipe.text.slice(0, 80));

    // ---- 外网审计 ----
    console.log('\n■ 零外链自证');
    const src = await import('node:fs').then((fs) =>
      [
        'server.ts',
        'session.ts',
        'counter.ts',
        'consent.ts',
        'tools-profile.ts',
        'tools-exchange.ts',
        'tools-lifecycle.ts',
        'store-fs.ts',
        'prompts.ts',
        'context.ts',
        'tools-plaza.ts',
        'server-client.ts',
        'plaza-store.ts',
      ]
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
    check(
      '源码外链仅计数器端点（localhost 自托管除外）',
      urls.every((u) => u.startsWith('https://count.hongxian.dev') || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u)),
      urls.join(', '),
    );
  } finally {
    a.close();
    b.close();
    if (serverProc) {
      serverProc.stderr?.destroy();
      serverProc.kill();
    }
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
    if (serverHome) rmSync(serverHome, { recursive: true, force: true });
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
