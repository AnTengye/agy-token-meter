(() => {
  const POLL_MS = 2500;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    tab: 'session',
    conv: '',
    etag: '',
    range: 'today',
    timer: null,
    lastData: null,
    overviewLoaded: false,
  };

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #ffffff)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v);
  }

  function fmtExact(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  function shortModel(name) {
    if (!name) return '-';
    return name
      .replace(/^gemini-4-hydrogen-tiered-/, 'g4-hydrogen-')
      .replace(/^gemini-4-/, 'g4-')
      .replace(/^gemini-pro-orchestrator-/, 'orch-')
      .replace(/^gemini-/, 'g-')
      .replace(/^claude-/, 'c-');
  }

  function hitTone(rate) {
    if (rate >= 75) return 'good';
    if (rate >= 40) return 'warn';
    return 'bad';
  }

  function setBar(el, valEl, rate) {
    const r = Math.max(0, Math.min(100, Number(rate) || 0));
    const tone = hitTone(r);
    el.style.width = `${r}%`;
    el.className = `bar-fill bg-${tone}`;
    if (valEl) {
      valEl.textContent = `${r.toFixed(1)}%`;
      valEl.className = valEl.className.replace(/\btone-(good|warn|bad)\b/g, '').trim() + ` tone-${tone}`;
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function jumpToConversation(cid) {
    if (!cid) return;
    if (window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(cid);
    }
  }

  function renderModels(container, list) {
    container.innerHTML = '';
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'model-row';
      const tone = hitTone(m.hitRate);
      row.innerHTML = `
        <span class="model-name" title="${esc(m.model)}">${esc(shortModel(m.model))}</span>
        <span>${fmtNum(m.totalTokens)} · ${m.calls}次 · <strong class="tone-${tone}">${m.hitRate.toFixed(1)}%</strong></span>
      `;
      container.appendChild(row);
    }
  }

  function renderTurns(turns) {
    const chart = $('turns-chart');
    const tip = $('turn-tooltip');
    chart.innerHTML = '';
    if (!turns || turns.length === 0) {
      tip.textContent = '暂无调用记录';
      return;
    }

    const maxIn = Math.max(...turns.map((t) => t.totalInput || 1), 1);
    const last = turns[turns.length - 1];
    const formatTip = (t, i) =>
      `#${i + 1} ${fmtTime(t.ts)} · ${shortModel(t.model)} · 输入 ${fmtExact(t.totalInput)} (命中 ${fmtExact(t.cacheRead)} / ${t.hitRate.toFixed(1)}%) · 输出 ${fmtExact(t.output)}${t.isCompaction ? ' · [压缩]' : ''}`;
    tip.textContent = formatTip(last, turns.length - 1);

    turns.forEach((t, idx) => {
      const col = document.createElement('div');
      col.className = 'turn-col';
      const pctH = Math.max(8, Math.round(((t.totalInput || 0) / maxIn) * 100));
      const hitPct = Math.max(0, Math.min(100, t.hitRate || 0));
      const missPct = 100 - hitPct;

      if (t.isCompaction) {
        const flag = document.createElement('span');
        flag.className = 'turn-flag turn-flag-comp';
        col.appendChild(flag);
      } else if (idx > 0 && t.cacheRead === 0 && t.totalInput > 0) {
        const flag = document.createElement('span');
        flag.className = 'turn-flag turn-flag-zero';
        col.appendChild(flag);
      }

      const bar = document.createElement('div');
      bar.className = 'turn-bar';
      bar.style.height = `${pctH}%`;
      bar.innerHTML = `
        <div class="turn-bar-miss" style="height:${missPct}%"></div>
        <div class="turn-bar-hit" style="height:${hitPct}%"></div>
      `;
      col.appendChild(bar);
      col.addEventListener('mouseenter', () => {
        tip.textContent = formatTip(t, idx);
      });
      chart.appendChild(col);
    });
  }

  function renderMembers(container, members, omittedCount) {
    container.innerHTML = '';
    for (const m of members) {
      const item = document.createElement('div');
      item.className = `member-item${m.isCurrent ? ' current' : ''}`;
      item.title = `${m.cid}\n点击跳转到该会话`;
      const tone = hitTone(m.hitRate);
      const roleTag = m.isRoot ? 'root' : `d${m.depth}`;
      const label = m.agent || m.role || m.cid.slice(0, 8);
      const subText = [roleTag, m.model ? shortModel(m.model) : '', `${m.calls}次`].filter(Boolean).join(' · ');

      item.innerHTML = `
        <div class="member-left">
          <span class="status-dot${m.isActive ? ' active' : ''}"></span>
          <div style="min-width:0">
            <div class="member-name">${esc(label)}${m.isCurrent ? ' (当前)' : ''}</div>
            <div class="member-sub">${esc(subText)}</div>
          </div>
        </div>
        <div class="member-right">
          <div class="member-tok">${fmtNum(m.totalTokens)}</div>
          <div class="member-hit tone-${tone}">${m.hitRate.toFixed(1)}%</div>
        </div>
      `;
      item.addEventListener('click', () => jumpToConversation(m.cid));
      container.appendChild(item);
    }
    const omEl = $('members-omitted');
    if (omittedCount > 0) {
      omEl.classList.remove('hidden');
      omEl.textContent = `已展示活跃与 Top ${members.length} 成员，另有 ${omittedCount} 个低消耗子会话已折叠`;
    } else {
      omEl.classList.add('hidden');
    }
  }

  function renderSession(data) {
    state.lastData = data;
    const badge = $('mode-badge');
    const modelPill = $('model-pill');

    const modeMap = {
      single: ['单会话', 'badge-neutral'],
      swarm: [`Swarm · ${data.family?.totalMembers || 1}`, 'badge-swarm'],
      teamwork: [`Teamwork · ${data.family?.totalMembers || 1}`, 'badge-teamwork'],
      subagents: [`子代理 · ${data.family?.totalMembers || 1}`, 'badge-subagents'],
      empty: ['无会话', 'badge-neutral'],
    };
    const [modeText, modeCls] = modeMap[data.mode] || modeMap.single;
    badge.textContent = modeText;
    badge.className = `badge ${modeCls}`;

    const self = data.self || {};
    const fam = data.family || {};
    modelPill.textContent = shortModel(self.primaryModel || fam.byModel?.[0]?.model || '');
    modelPill.title = self.primaryModel || '';

    if (!data.conversationId || (!data.exists && (!fam || fam.calls === 0))) {
      $('session-empty').classList.remove('hidden');
      $('session-content').classList.add('hidden');
      $('session-empty-desc').textContent = data.conversationId
        ? `会话 ${data.conversationId.slice(0, 8)} 尚未产生模型调用记录。`
        : '未检测到活动会话 ID。';
      return;
    }

    $('session-empty').classList.add('hidden');
    $('session-content').classList.remove('hidden');

    const titleText = data.title || data.rootTitle || `会话 ${data.conversationId.slice(0, 8)}`;
    $('session-title').textContent = titleText;
    $('session-title').title = titleText;
    $('session-meta').textContent = `${data.conversationId.slice(0, 8)}${data.rootId && data.rootId !== data.conversationId ? ` ↳ root ${data.rootId.slice(0, 8)}` : ''} · 更新 ${fmtTime(self.lastTs || fam.byModel?.[0]?.lastTs || data.updatedAt / 1000)}`;

    const isTree = fam.totalMembers > 1;
    $('family-compare').classList.toggle('hidden', !isTree);
    $('single-hero').classList.toggle('hidden', isTree);
    $('family-details').classList.toggle('hidden', !isTree);
    $('members-card').classList.toggle('hidden', !isTree);

    if (isTree) {
      $('cmp-self-calls').textContent = `${self.calls} 次`;
      $('cmp-self-total').textContent = fmtNum(self.totalTokens);
      $('cmp-self-total').title = fmtExact(self.totalTokens);
      setBar($('cmp-self-bar'), $('cmp-self-hit'), self.hitRate);

      $('cmp-family-label').textContent = data.mode === 'swarm' ? 'Swarm 全组' : data.mode === 'teamwork' ? 'Teamwork 全树' : '全组汇总';
      $('cmp-family-nodes').textContent = `${fam.totalMembers} 节点${fam.activeMembers ? ` · ${fam.activeMembers} 活跃` : ''}`;
      $('cmp-family-total').textContent = fmtNum(fam.totalTokens);
      $('cmp-family-total').title = fmtExact(fam.totalTokens);
      setBar($('cmp-family-bar'), $('cmp-family-hit'), fam.hitRate);

      $('fam-detail-calls').textContent = `${fam.calls} 次调用 · ${fam.compactions} 次压缩`;
      $('fam-in').textContent = fmtNum(fam.totalInput);
      $('fam-unc').textContent = fmtNum(fam.uncachedInput);
      $('fam-cr').textContent = fmtNum(fam.cacheRead);
      $('fam-out').textContent = fmtNum(fam.output);

      const showDepths = fam.depthSummary && fam.depthSummary.length > 1;
      $('depth-wrap').classList.toggle('hidden', !showDepths);
      if (showDepths) {
        const dl = $('depth-list');
        dl.innerHTML = '';
        for (const d of fam.depthSummary) {
          const row = document.createElement('div');
          row.className = 'depth-row';
          const tone = hitTone(d.hitRate);
          row.innerHTML = `
            <span>depth ${d.depth} (${d.sessions}会话)</span>
            <span>${fmtNum(d.totalTokens)} · ${d.calls}次 · <strong class="tone-${tone}">${d.hitRate.toFixed(1)}%</strong></span>
          `;
          dl.appendChild(row);
        }
      }

      const showFamModels = fam.byModel && fam.byModel.length > 0;
      $('family-models-wrap').classList.toggle('hidden', !showFamModels);
      if (showFamModels) renderModels($('family-models'), fam.byModel);

      $('members-title').textContent = `成员消耗榜 (${data.totalMemberCount})`;
      renderMembers($('members-list'), data.members || [], data.omittedCount || 0);
    } else {
      $('hero-total').textContent = fmtNum(self.totalTokens);
      $('hero-total').title = fmtExact(self.totalTokens);
      setBar($('hero-bar'), $('hero-hit'), self.hitRate);
    }

    $('kpi-in').textContent = fmtNum(self.totalInput);
    $('kpi-in').title = fmtExact(self.totalInput);
    $('kpi-in-sub').textContent = `未命中 ${fmtNum(self.uncachedInput)} · 命中 ${fmtNum(self.cacheRead)}`;

    $('kpi-out').textContent = fmtNum(self.output);
    $('kpi-out').title = fmtExact(self.output);
    $('kpi-out-sub').textContent = `思考 ${fmtNum(self.thinking)} · 文本 ${fmtNum(self.visibleOutput)}`;

    const lt = self.lastTurn;
    $('kpi-ctx').textContent = lt ? fmtNum(lt.totalInput) : '0';
    $('kpi-ctx').title = lt ? fmtExact(lt.totalInput) : '0';
    $('kpi-ctx-sub').textContent = lt ? `上轮命中 ${lt.hitRate.toFixed(1)}%` : '暂无调用';

    $('kpi-calls').textContent = String(self.calls || 0);
    $('kpi-calls-sub').textContent = `压缩 ${self.compactions || 0} 次`;

    const showSelfModels = !isTree && self.models && self.models.length > 1;
    $('self-models-card').classList.toggle('hidden', !showSelfModels);
    if (showSelfModels) renderModels($('self-models'), self.models);

    renderTurns(self.recentTurns || []);
  }

  function renderOverview(data) {
    $('overview-loading').classList.add('hidden');
    $('overview-content').classList.remove('hidden');

    const t = data.totals || {};
    $('overview-cost').textContent = `${data.computedMs ?? 0}ms${data.cached ? ' (缓存)' : ''}`;
    $('ov-total').textContent = fmtNum(t.totalTokens);
    $('ov-total').title = fmtExact(t.totalTokens);
    setBar($('ov-bar'), $('ov-hit'), t.hitRate);

    $('ov-sess').textContent = `${t.sessions || 0} / ${t.roots || 0}`;
    $('ov-calls').textContent = `${t.calls || 0} / ${t.compactions || 0}`;
    $('ov-cr').textContent = fmtNum(t.cacheRead);
    $('ov-unc').textContent = fmtNum(t.uncachedInput);
    $('ov-out').textContent = fmtNum(t.output);

    renderModels($('ov-models'), data.byModel || []);

    const rootsEl = $('ov-roots');
    rootsEl.innerHTML = '';
    for (const r of data.roots || []) {
      const item = document.createElement('div');
      item.className = 'member-item';
      item.title = `${r.rootId}\n点击跳转到该根会话`;
      const tone = hitTone(r.hitRate);
      const sub = `${r.mode} · ${r.sessionCount}会话 · ${r.calls}次`;
      item.innerHTML = `
        <div class="member-left">
          <div style="min-width:0">
            <div class="member-name">${esc(r.title || r.rootId.slice(0, 8))}</div>
            <div class="member-sub">${esc(sub)}</div>
          </div>
        </div>
        <div class="member-right">
          <div class="member-tok">${fmtNum(r.totalTokens)}</div>
          <div class="member-hit tone-${tone}">${r.hitRate.toFixed(1)}%</div>
        </div>
      `;
      item.addEventListener('click', () => jumpToConversation(r.rootId));
      rootsEl.appendChild(item);
    }
  }

  async function pollSession(force = false) {
    const conv = currentConv();
    if (conv !== state.conv) {
      state.conv = conv;
      state.etag = '';
    }
    if (!conv) {
      renderSession({ conversationId: null, mode: 'empty', exists: false });
      return;
    }
    try {
      const q = `/api/session?conversationId=${encodeURIComponent(conv)}${!force && state.etag ? `&etag=${encodeURIComponent(state.etag)}` : ''}`;
      const data = await getJson(q);
      if (data.unchanged) return;
      state.etag = data.etag || '';
      renderSession(data);
    } catch (err) {
      console.error('pollSession failed:', err);
    }
  }

  async function loadOverview(force = false) {
    if (!state.overviewLoaded) {
      $('overview-loading').classList.remove('hidden');
      $('overview-content').classList.add('hidden');
    }
    try {
      const data = await getJson(`/api/overview?range=${encodeURIComponent(state.range)}${force ? '&force=1' : ''}`);
      state.overviewLoaded = true;
      renderOverview(data);
    } catch (err) {
      console.error('loadOverview failed:', err);
      $('overview-loading').classList.add('hidden');
    }
  }

  function startPolling() {
    stopPolling();
    if (document.hidden || state.tab !== 'session') return;
    state.timer = setInterval(() => pollSession(false), POLL_MS);
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab;
      if (next === state.tab) return;
      state.tab = next;
      document.querySelectorAll('.tab').forEach((b) => {
        const active = b.dataset.tab === next;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      $('view-session').classList.toggle('hidden', next !== 'session');
      $('view-overview').classList.toggle('hidden', next !== 'overview');
      if (next === 'session') {
        pollSession(false);
        startPolling();
      } else {
        stopPolling();
        loadOverview(false);
      }
    });
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range;
      if (r === state.range) return;
      state.range = r;
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === r));
      loadOverview(false);
    });
  });

  $('refresh-btn').addEventListener('click', () => {
    if (state.tab === 'session') pollSession(true);
    else loadOverview(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else if (state.tab === 'session') {
      pollSession(false);
      startPolling();
    }
  });

  pollSession(true);
  startPolling();
})();
