/* 红线产品网站 · playwright 渲染与交互验证脚本 */
const { chromium } = require('playwright');

(async () => {
  const base = 'http://127.0.0.1:8901';
  const outDir = 'D:/7-sunchao资料/红线项目/apps/web/.verify';
  const browser = await chromium.launch({ channel: 'msedge' });
  const results = [];

  function ok(name, pass, detail) {
    results.push({ name, pass, detail: detail || '' });
    console.log((pass ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  }

  /* ---------- 桌面端 ---------- */
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  const externalReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://127.0.0.1:8901')) externalReqs.push(u);
  });

  await page.goto(base, { waitUntil: 'networkidle' }).catch(() => {});

  ok('页面加载', true, await page.title());

  /* Hero 与七区锚点 */
  for (const id of ['how', 'demo', 'trust', 'data', 'faq']) {
    const visible = await page.locator('#' + id).isVisible().catch(() => false);
    ok('区块 #' + id + ' 可见', visible);
  }

  /* 三步安装面板 */
  await page.click('#install-btn');
  await page.waitForTimeout(400);
  ok('安装面板展开', await page.locator('#install-panel').isVisible());

  /* Demo 流程走查 */
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600); // 等第一条消息出现
  const msgCount0 = await page.locator('.msg').count();
  ok('Demo 首条消息渲染', msgCount0 >= 1, msgCount0 + ' 条');

  // 依次点完四个选项（城市/周末/敏感题/复述确认）
  for (let i = 0; i < 4; i++) {
    await page.locator('.opt-btn').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900);
  }
  const chatText = await page.locator('#chat-body').innerText();
  ok('Demo 走完四句', chatText.includes('我理解的你是'), '含复述确认稿');
  ok('敏感题渲染', await page.locator('.msg-sensitive').count() >= 1);

  // 看报告
  await page.click('#demo-report-btn');
  await page.waitForTimeout(400);
  ok('样例报告展开', await page.locator('#report-wrap').isVisible());
  ok('五档条渲染', (await page.locator('.tier').count()) === 5);

  // 重新演示
  await page.click('#demo-restart');
  await page.waitForTimeout(400);
  ok('重新演示重置', (await page.locator('.msg').count()) <= 2);

  /* 透明数据区降级 */
  const emptyVisible = await page.locator('#stats-empty').isVisible();
  ok('数据区降级文案（无计数器时）', emptyVisible);

  /* FAQ */
  await page.locator('.faq-item summary').first().click();
  await page.waitForTimeout(200);
  ok('FAQ 展开', await page.locator('.faq-item').first().evaluate(el => el.open));

  /* 截图 */
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: outDir + '/desktop-hero.png' });
  await page.locator('#how').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: outDir + '/desktop-how.png' });
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: outDir + '/desktop-demo.png' });
  await page.locator('#data').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: outDir + '/desktop-data.png' });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await page.screenshot({ path: outDir + '/desktop-footer.png' });

  /* ---------- 移动端 ---------- */
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mob.goto(base, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await mob.waitForTimeout(800);
  await mob.screenshot({ path: outDir + '/mobile-hero.png' });
  await mob.click('.nav-toggle');
  await mob.waitForTimeout(300);
  ok('移动端菜单展开', await mob.locator('.nav').isVisible());
  await mob.screenshot({ path: outDir + '/mobile-nav.png' });

  /* ---------- 汇总 ---------- */
  const uniqueExternal = [...new Set(externalReqs)];
  ok('无意外外部请求', uniqueExternal.every(u => u.includes('count.hongxian.dev') || u.includes('github.com')),
     uniqueExternal.join(' | ') || '仅本地资源');
  ok('无控制台错误', consoleErrors.length === 0, consoleErrors.join(' ; ') || '干净');

  await browser.close();
  const failed = results.filter(r => !r.pass).length;
  console.log('\n===== 验证完成：' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
