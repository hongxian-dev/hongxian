#!/usr/bin/env node
/**
 * 宿主级冒烟测试（stdio 协议面）——v1 清单"真机安装实测"的自动化替身
 *
 * 与 run-e2e.mjs 的区别：那个直接调用 handler（进程内），这个走**真正的 STDIO 传输**——
 * 起一个独立子进程，按 MCP 协议发 initialize → tools/list → tools/call，
 * 验证的是"宿主（WorkBuddy / Claude Desktop / Cursor）看到的那一面"：
 *
 *   1. 进程能起来、不往 stdout 写日志（协议铁律：stdout 只走协议帧）
 *   2. initialize 握手成功并声明 tools 能力
 *   3. tools/list 返回 21 件工具 + 每件都有 name/description/inputSchema
 *   4. prompts/list 返回 8 条指引
 *   5. tools/call 真的能跑通（未同意前拒绝服务 = S1 知情同意的协议面证据）
 *   6. 未解锁时的错误是"人话"而不是堆栈
 *
 * 用法：node packages/mcp/e2e/host-smoke.mjs  （需先 npm run build）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 极简 JSON-RPC over stdio 客户端（换行分隔 JSON，MCP stdio 传输格式） */
function startHost(home) {
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HONGXIAN_HOME: home },
  });
  const pending = new Map();
  let buf = '';
  let stdoutNoise = '';
  const stderrLog = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // stdout 上出现非 JSON = 违反协议铁律（日志必须走 stderr）
        stdoutNoise += line;
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderrLog.push(d));

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} 超时（10s）`)), 10_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  return {
    child,
    request,
    notify,
    get stdoutNoise() {
      return stdoutNoise;
    },
    get stderrText() {
      return stderrLog.join('');
    },
  };
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'hx-host-'));
  console.log('■ 宿主级冒烟（STDIO 协议面）');
  const host = startHost(home);

  try {
    // 1. 握手
    const init = await host.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'host-smoke', version: '0.0.0' },
    });
    check('initialize 握手成功', !!init.result, JSON.stringify(init.error ?? {}).slice(0, 160));
    check(
      '声明 tools 能力（宿主据此挂载工具面板）',
      init.result?.capabilities?.tools !== undefined,
      JSON.stringify(init.result?.capabilities ?? {}),
    );
    check('返回服务器身份信息', typeof init.result?.serverInfo?.name === 'string', JSON.stringify(init.result?.serverInfo ?? {}));
    host.notify('notifications/initialized', {});

    // 2. 工具面
    const tools = await host.request('tools/list', {});
    const list = tools.result?.tools ?? [];
    check('tools/list 返回 21 件工具', list.length === 21, `实际 ${list.length}`);
    check(
      '每件工具都有 name / description / inputSchema（宿主渲染所需三件套）',
      list.every((t) => typeof t.name === 'string' && typeof t.description === 'string' && t.inputSchema !== undefined),
    );
    const names = list.map((t) => t.name);
    for (const required of ['interview', 'sign_card', 'compare', 'round', 'meeting_kit', 'debrief', 'view_l3', 'plaza_browse', 'report_abuse']) {
      check(`工具存在：${required}`, names.includes(required));
    }

    // 3. 指引面
    const prompts = await host.request('prompts/list', {});
    check('prompts/list 返回 8 条指引', (prompts.result?.prompts ?? []).length === 8, `实际 ${(prompts.result?.prompts ?? []).length}`);

    // 4. 真调用一通：未进门之前必须先把丑话说清（S1 + 防护一）
    //    顺序是「风险提示 → 知情同意」：先知道会出什么事，再决定要不要开始
    const first = await host.request('tools/call', { name: 'interview', arguments: { action: 'start' } });
    const firstText = first.result?.content?.[0]?.text ?? '';
    check(
      '未进门先给风险提示（防护一 / C2①）',
      /红线是工具，不是婚介/.test(firstText) && /interview\(action="ack"\)/.test(firstText),
      firstText.slice(0, 160),
    );
    const acked = await host.request('tools/call', { name: 'interview', arguments: { action: 'ack' } });
    const consentText = acked.result?.content?.[0]?.text ?? '';
    check('确认风险提示后给知情同意书（S1）', /知情同意|18 周岁/.test(consentText), consentText.slice(0, 200));
    check('提示是"人话"而非堆栈', !/at .*\.js:\d+|TypeError|undefined is not/.test(consentText), consentText.slice(0, 160));

    // 5. 未知工具 → 明确报错，不是静默
    const unknown = await host.request('tools/call', { name: 'no_such_tool', arguments: {} });
    check(
      '调用不存在的工具会明确报错',
      !!unknown.error || unknown.result?.isError === true,
      JSON.stringify(unknown.error ?? unknown.result ?? {}).slice(0, 200),
    );

    // 6. 协议铁律：stdout 上不能有日志噪声
    check('stdout 只走协议帧（日志全在 stderr）', host.stdoutNoise.length === 0, host.stdoutNoise.slice(0, 160));
    check('stderr 有启动日志（可排查）', /yuelao|月老/.test(host.stderrText), host.stderrText.slice(0, 160));
  } finally {
    host.child.kill();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n===== 宿主冒烟完成：${pass}/${pass + failures.length} 通过 =====`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('宿主冒烟异常：', e);
  process.exit(1);
});
