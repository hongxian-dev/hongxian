/* ============================================================
   红线 Hongxian · 产品介绍网站交互脚本
   纯 vanilla JS，零依赖、零追踪、零外部请求。
   Demo 区为纯前端预设脚本，不调用任何模型、不发起任何网络请求。
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function sleep(ms) {
    return new Promise (function (resolve) { setTimeout(resolve, reduceMotion ? 0 : ms); });
  }

  /* ---------- 页脚年份 ---------- */
  var yearEl = $('#year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- 移动端导航 ---------- */
  var navToggle = $('.nav-toggle');
  var nav = $('.nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
    });
    $$('.nav-links a').forEach(function (link) {
      link.addEventListener('click', function () {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ---------- 三步安装面板 ---------- */
  var installBtn = $('#install-btn');
  var installPanel = $('#install-panel');
  if (installBtn && installPanel) {
    installBtn.addEventListener('click', function () {
      var willOpen = installPanel.hasAttribute('hidden');
      if (willOpen) {
        installPanel.removeAttribute('hidden');
        installPanel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
      } else {
        installPanel.setAttribute('hidden', '');
      }
      installBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  }

  /* ---------- 复制按钮 ---------- */
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 用户可手动复制 */ }
    document.body.removeChild(ta);
  }
  $$('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-copy-target'));
      if (!target) return;
      var text = target.textContent;
      function done() {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text); done();
      }
    });
  });

  /* ============================================================
     Demo 体验区：预设脚本（纯前端，无模型、无网络）
     流程：打招呼 → 三句访谈（第三句为敏感题）→ 复述确认 → 收尾 → 样例报告
     ============================================================ */
  var chatBody = $('#chat-body');
  var chatOptions = $('#chat-options');
  var restartBtn = $('#demo-restart');
  var reportBtn = $('#demo-report-btn');
  var reportWrap = $('#report-wrap');

  var demoSteps = [
    {
      say: '你好，我是月老。今天我们先聊三句，认识一下你。\n点着选就行——真实的访谈比这深得多，也慢得多。'
    },
    {
      ask: '先来个简单的：你生活在哪个城市，大致哪个年龄段？',
      options: ['32 岁，杭州', '28 岁，上海', '35 岁，成都']
    },
    {
      ask: '周末你一般怎么过？',
      options: ['爬山徒步，户外派', '宅家看书看电影', '约朋友吃饭聊天']
    },
    {
      sensitive: true,
      ask: '接下来这个问题，可能有点不好意思开口——你对「三年内要不要孩子」怎么看？\n放心，以后这个问题由我替你问对方，你不用亲自问。',
      options: ['希望三年内安定下来', '还没想好，看缘分', '暂时不想要']
    },
    {
      confirm: true
    },
    {
      finale: true
    }
  ];

  var answers = {};
  var currentStep = 0;

  function buildRecap() {
    var a1 = answers.a1 || '32 岁，杭州';
    var a2 = answers.a2 || '爬山徒步，户外派';
    var a3 = answers.a3 || '希望三年内安定下来';
    return '我理解的你是：' + a1 + '；周末' + a2 + '；关于孩子，你' + a3 + '。\n我记下了，对吗？';
  }

  function scrollChat() {
    if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
  }

  function addMessage(text, who) {
    var div = document.createElement('div');
    div.className = 'msg msg-' + (who || 'yuelao');
    div.textContent = text;
    chatBody.appendChild(div);
    scrollChat();
    return div;
  }

  function addTyping() {
    var div = document.createElement('div');
    div.className = 'msg msg-typing';
    div.textContent = '月老正在输入…';
    chatBody.appendChild(div);
    scrollChat();
    return div;
  }

  function setOptions(options, onPick) {
    chatOptions.innerHTML = '';
    options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt-btn';
      btn.textContent = opt;
      btn.addEventListener('click', function () {
        $$('.opt-btn', chatOptions).forEach(function (b) { b.disabled = true; });
        addMessage(opt, 'user');
        chatOptions.setAttribute('hidden', '');
        chatOptions.innerHTML = '';
        onPick(opt);
      });
      chatOptions.appendChild(btn);
    });
    chatOptions.removeAttribute('hidden');
    scrollChat();
  }

  async function runStep(index, picked) {
    if (index >= demoSteps.length) { finishDemo(); return; }
    currentStep = index;
    var step = demoSteps[index];

    /* 记录前三句访谈的回答 */
    if (index === 1 && picked !== undefined) answers.a1 = picked;
    if (index === 2 && picked !== undefined) answers.a2 = picked;
    if (index === 3 && picked !== undefined) answers.a3 = picked;

    /* 复述确认步：先呈现「我理解的你是…」，等用户拍板 */
    if (step.confirm) {
      var t0 = addTyping();
      await sleep(650);
      t0.remove();
      addMessage(buildRecap());
      await sleep(250);
      setOptions(['就是这样', '我再改改'], function (opt) {
        runStep(index + 1, opt);
      });
      return;
    }

    /* 收尾步：按用户对复述确认的回应致辞 */
    if (step.finale) {
      var t1 = addTyping();
      await sleep(600);
      t1.remove();
      if (picked === '我再改改') {
        addMessage('好，那我们改。在真实的月老里，你随时可以说「改一下」——画像由你亲手确认，才算数。改好了，一样进入签发匹配卡的流程。');
      } else {
        addMessage('好，那我不打扰了。真实流程里，接下来是签发三层匹配卡、名片互换、本地比对。今天先看看，月老能给出什么样的报告。');
      }
      finishDemo();
      return;
    }

    /* 普通发言 / 提问步 */
    var t = addTyping();
    await sleep(step.sensitive ? 800 : 550);
    t.remove();

    var msg = addMessage(step.say || step.ask, 'yuelao');
    if (step.sensitive) msg.classList.add('msg-sensitive');

    if (step.options) {
      await sleep(250);
      setOptions(step.options, function (opt) {
        runStep(index + 1, opt);
      });
    } else {
      await sleep(250);
      runStep(index + 1);
    }
  }

  function finishDemo() {
    if (reportBtn) reportBtn.removeAttribute('hidden');
    if (restartBtn) restartBtn.removeAttribute('hidden');
  }

  if (reportBtn) {
    reportBtn.addEventListener('click', function () {
      reportWrap.removeAttribute('hidden');
      reportBtn.setAttribute('hidden', '');
      reportWrap.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener('click', function () {
      answers = {};
      currentStep = 0;
      chatBody.innerHTML = '';
      chatOptions.innerHTML = '';
      chatOptions.setAttribute('hidden', '');
      reportWrap.setAttribute('hidden', '');
      reportBtn.setAttribute('hidden', '');
      restartBtn.setAttribute('hidden', '');
      runStep(0);
    });
  }

  if (chatBody) runStep(0);

  /* ============================================================
     透明数据区：拉取匿名聚合计数（失败则静默降级为「等待第一个用户」）
     ============================================================ */
  var STATS_URL = 'https://count.hongxian.dev/stats';
  var STATS_TIMEOUT = 4000;

  function fmt(n) {
    return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('zh-CN') : '—';
  }

  function hasData(counters) {
    return counters && Object.keys(counters).some(function (k) {
      return typeof counters[k] === 'number' && counters[k] > 0;
    });
  }

  function renderStats(counters) {
    $('#stat-cards').textContent = fmt(counters.cards_total);
    $('#stat-active').textContent = fmt(counters.cards_active_30d);
    $('#stat-exchanges').textContent = fmt(counters.exchanges_total);

    /* 性别比例 */
    var gf = counters.gender_female || 0;
    var gm = counters.gender_male || 0;
    var gTotal = gf + gm;
    if (gTotal > 0) {
      var pf = Math.round((gf / gTotal) * 100);
      $('#bar-f').style.width = pf + '%';
      $('#bar-m').style.width = (100 - pf) + '%';
      $('#bar-f-num').textContent = '女 ' + pf + '%';
      $('#bar-m-num').textContent = '男 ' + (100 - pf) + '%';
      $('#stat-gender').removeAttribute('hidden');
      $('#gender-empty').setAttribute('hidden', '');
    }

    /* 年龄段分布 */
    var bands = [
      ['18_25', '18–25'], ['26_30', '26–30'], ['31_35', '31–35'],
      ['36_40', '36–40'], ['40_plus', '40+']
    ];
    var bandTotal = 0;
    bands.forEach(function (b) { bandTotal += counters['age_band_' + b[0]] || 0; });
    if (bandTotal > 0) {
      var ageBar = $('#stat-age');
      ageBar.innerHTML = '';
      bands.forEach(function (b) {
        var v = counters['age_band_' + b[0]] || 0;
        if (v <= 0) return;
        var seg = document.createElement('div');
        seg.className = 'bar-seg';
        seg.style.width = ((v / bandTotal) * 100).toFixed(1) + '%';
        seg.textContent = b[1];
        seg.title = b[1] + '：' + v.toLocaleString('zh-CN');
        ageBar.appendChild(seg);
      });
      ageBar.removeAttribute('hidden');
      $('#age-empty').setAttribute('hidden', '');
    }
  }

  function showStatsEmpty() {
    var el = $('#stats-empty');
    if (el) el.removeAttribute('hidden');
  }

  (function loadStats() {
    if (!window.fetch) { showStatsEmpty(); return; }
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, STATS_TIMEOUT) : null;
    fetch(STATS_URL, { signal: controller ? controller.signal : undefined, cache: 'no-store' })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error('stats http ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var counters = (data && data.counters) || {};
        if (hasData(counters)) {
          renderStats(counters);
        } else {
          showStatsEmpty();
        }
      })
      .catch(function () {
        showStatsEmpty();
      });
  })();

  /* ============================================================
     滚动显现动画（渐进增强；不支持时内容直接可见）
     ============================================================ */
  if ('IntersectionObserver' in window && !reduceMotion) {
    var targets = $$('.section-head, .how-card, .trust-step, .stat-card, .faq-item, .sponsor');
    targets.forEach(function (el) { el.classList.add('reveal'); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    targets.forEach(function (el) { io.observe(el); });
  }
})();
