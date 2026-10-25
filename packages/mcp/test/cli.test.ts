/**
 * CLI 入口行为：终端里直接运行不许「静默挂住」
 *
 * 起因（2026-10-25）：新用户在全新环境里照做，把 `npx -y @hongxian/mcp`
 * 直接跑起来 —— 进程零输出、永不结束，看起来像卡死。
 * 它不是安装脚本，是 STDIO 服务；这个区别只能在它自己开口时被理解。
 *
 * 要证明：
 *   1. stdin 是终端（有人真在跑命令）→ 打印用法说明并正常退出，不挂住
 *   2. `--print-config` 输出的就是可直接粘贴的 mcpServers 片段，且是合法 JSON
 *   3. `--version` 与 package.json 一致（不许写死，0.1.1 发布时踩过）
 *   4. 管道（宿主拉起）路径不受影响：initialize 仍能正常握手
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const PKG = require('../package.json') as { version: string };
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** 跑一次 CLI；stdin 默认给空管道（模拟宿主以外的调用）。 */
function run(args: string[], opts: { stdin?: string; tty?: boolean; timeoutMs?: number } = {}): Promise<Run> {
  const { stdin = '', tty = false, timeoutMs = 15000 } = opts;
  return new Promise((resolve) => {
    const exec = tty
      ? // 无法在测试里申请 pty，用同进程改写 isTTY 后再加载入口——测的是同一条分支
        [process.execPath, ['-e', `process.stdin.isTTY=true;process.argv=['node','x'];import(${JSON.stringify(pathToFileURL(DIST).href)});`]]
      : [process.execPath, [DIST, ...args]];
    const cp = spawn(exec[0] as string, exec[1] as string[], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cp.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    cp.stdout.on('data', (d) => (stdout += d.toString()));
    cp.stderr.on('data', (d) => (stderr += d.toString()));
    cp.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    if (!tty) cp.stdin.end(stdin);
  });
}

describe('CLI 入口：终端直跑必须开口', () => {
  it('stdin 是终端 → 打印说明并退出，不静默挂住', async () => {
    const r = await run([], { tty: true });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('不是安装脚本');
    expect(r.stdout).toContain('宿主');
    expect(r.stdout).toContain('@hongxian/mcp');
    // 真正的坑：一字不吐地等输入
    expect(r.stdout.length).toBeGreaterThan(200);
  });

  it('--print-config 输出合法且可直接粘贴', async () => {
    const r = await run(['--print-config']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(j.mcpServers.hongxian.command).toBe('npx');
    expect(j.mcpServers.hongxian.args).toEqual(['-y', '@hongxian/mcp']);
  });

  it('--version 跟着 package.json 走，不许写死', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PKG.version);
  });

  it('未知参数明确拒绝（退出码 2）', async () => {
    const r = await run(['--nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('未知参数');
  });

  it('管道路径不受影响：initialize 仍能握手', async () => {
    const init =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"host","version":"0"}}}\n';
    const r = await run([], { stdin: init, timeoutMs: 20000 });
    const line = r.stdout.split('\n').find((l) => l.includes('"serverInfo"'));
    expect(line, `stdout=${r.stdout.slice(0, 200)}`).toBeTruthy();
    const msg = JSON.parse(line as string) as { result: { serverInfo: { name: string; version: string } } };
    expect(msg.result.serverInfo.name).toBe('yuelao');
    // serverInfo.version 必须等于包版本（此前写死 0.1.0，发一版就错一版）
    expect(msg.result.serverInfo.version).toBe(PKG.version);
  });
});

describe('--print-config 覆盖四种配置载体', () => {
  it('不带目标仍是标准 JSON，提示只走 stderr（不污染可重定向的 stdout）', async () => {
    const r = await run(['--print-config']);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toContain('--print-config list');
  });

  it('openclaw 是带 transport 的合法 JSON（漏了这个字段不生效）', async () => {
    const r = await run(['--print-config', 'openclaw']);
    const j = JSON.parse(r.stdout) as { mcpServers: Record<string, { transport?: string }> };
    expect(j.mcpServers.hongxian.transport).toBe('stdio');
  });

  it('panel 给字段表；宿主别名 doubao 能路由到它', async () => {
    const r = await run(['--print-config', 'doubao']);
    expect(r.stdout).toContain('STDIO');
    expect(r.stdout).toContain('连接器');
    expect(r.stdout).toContain('hongxian');
    // 云桌面不是宿主这件事必须写在物料里，否则会被当成"装在云端也能用"
    expect(r.stdout).toContain('不是 MCP 宿主');
  });

  it('code 给命令行，dsh 给 YAML patch（两者都不是 mcpServers）', async () => {
    const c = await run(['--print-config', 'code']);
    expect(c.stdout).toContain('claude mcp add --transport stdio');
    const d = await run(['--print-config', 'dsh']);
    expect(d.stdout).toContain('cordis.patch.yml');
    expect(d.stdout).toContain('transport: stdio');
  });

  it('list 列出全部目标，未知目标明确拒绝', async () => {
    const l = await run(['--print-config', 'list']);
    for (const k of ['claude', 'openclaw', 'panel', 'code', 'dsh']) expect(l.stdout).toContain(k);
    const bad = await run(['--print-config', 'nope']);
    expect(bad.code).toBe(2);
  });

  it('所有模板都不许出现 @// 双斜杠（2026-10-25 真实安装失败的根因）', async () => {
    for (const t of ['claude', 'openclaw', 'panel', 'code', 'dsh']) {
      const r = await run(['--print-config', t]);
      expect(r.stdout, `${t} 里出现了双斜杠`).not.toContain('@//');
      expect(r.stdout).toContain('@hongxian/mcp');
    }
  });
});

describe('发布物一致性', () => {
  it('dist 里不再出现写死的 0.1.0', () => {
    const dist = readFileSync(DIST, 'utf8');
    expect(dist.includes("version: '0.1.0'")).toBe(false);
  });
});
