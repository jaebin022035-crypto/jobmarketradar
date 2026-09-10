// JobMarketRadar — 프론트 로직 (Step 4 + 5.5 + 5.6 + 6: 3뷰 구조 + 8: 인증)
// 뷰: 📊 대시보드 / 💡 인사이트 / 🎯 맞춤 공고 / 📝 이력서 관리(로그인 필요)  (SPA 탭 전환)
'use strict';

/* ---------------- 공통 ---------------- */
const CHART_COLORS = [
  '#2f7fd1', '#6a5cff', '#1f9d6b', '#c98a1a', '#e0606c',
  '#15a2b3', '#d96aa5', '#7aa623', '#e08a3c', '#4a90d9',
];

// 외부 프록시 경로 대응 (labport: https://.../g/<user>/<app>/)
const BASE = (() => {
  try {
    const cs = document.currentScript;
    return cs && cs.src ? new URL('.', cs.src).pathname : '';
  } catch { return ''; }
})();

async function api(path, opts = {}) {
  const rel = String(path).replace(/^\/+/, '');
  const init = { method: opts.method || 'GET' };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + rel, init);
  // 빈 응답(204 등) 처리
  const text = await res.text();
  if (!res.ok) {
    let msg = `API ${res.status} (${rel})`;
    let code = null;
    let serverMsg = null;
    try {
      const j = JSON.parse(text);
      msg += ': ' + (j.error || '');
      code = j.code || null;
      serverMsg = j.error || null;
    } catch { /* 본문 없으면 상태만 */ }
    const err = new Error(msg);
    err.code = code;
    err.serverMsg = serverMsg;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// AI 과부하(503 AI_BUSY) 공통 안내 — 폴백 모델까지 포화된 일시 장애
function isAiBusyError(e) {
  return e && (e.code === 'AI_BUSY' || /혼잡|잠시 후 다시/i.test(e.serverMsg || e.message || ''));
}

// null-safe 이벤트 바인딩 — 요소가 없으면 조용히 스킵 (캐시 불일치/뷰 미로딩 대비)
function on(id, ev, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
  else console.warn('[bind] 요소 없음:', id);
}

const nf = new Intl.NumberFormat('ko-KR');
const fmt = (n) => nf.format(n ?? 0);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function fmtRun(iso) {
  if (!iso) return '수집 전';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 수집`;
}

function applyChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = '#5c727b';
  Chart.defaults.font.family = "Pretendard, system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(255,255,255,.97)';
  Chart.defaults.plugins.tooltip.titleColor = '#1f2a33';
  Chart.defaults.plugins.tooltip.bodyColor = '#3a4750';
  Chart.defaults.plugins.tooltip.borderColor = '#cfe6e6';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
}

const charts = {};
function setChart(id, config) {
  if (charts[id]) charts[id].destroy();
  const el = document.getElementById(id);
  if (!el) return;
  charts[id] = new Chart(el, config);
}
function showEmpty(canvasId, msg) {
  const card = document.getElementById(canvasId)?.closest('.chart-card, .insight-section');
  const p = card?.querySelector('.empty-msg');
  if (p) { p.textContent = msg; p.hidden = false; }
}
function hideEmpty(canvasId) {
  const card = document.getElementById(canvasId)?.closest('.chart-card, .insight-section');
  const p = card?.querySelector('.empty-msg');
  if (p) p.hidden = true;
}

function trim(s, n = 12) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------------- 대시보드 상태 ---------------- */
const state = {
  period: 'all',
  company: '',
  region: '',
  category: '',
  itOnly: false,
  page: 1,
  size: 12,
};

// 대시보드 필터 → 쿼리스트링
function filterQS() {
  const p = new URLSearchParams();
  if (state.period && state.period !== 'all') p.set('period', state.period);
  if (state.company) p.set('companyType', state.company);
  if (state.region) p.set('region', state.region);
  if (state.category) p.set('category', state.category);
  if (state.itOnly) p.set('itOnly', '1');
  const s = p.toString();
  return s ? '?' + s : '';
}

/* ============================================================
   🔐 인증 (Step 8) — 로그인/회원가입/로그아웃 + 이력서 접근 제어
   ============================================================ */
const authState = { user: null };

// 헤더 로그인 영역 갱신: 미로그인 → 로그인 버튼 / 로그인 → 이름·로그아웃
function renderAuthUI() {
  const btn = document.getElementById('btn-login');
  const box = document.getElementById('auth-user');
  const nameEl = document.getElementById('auth-user-name');
  if (!btn || !box) return;
  if (authState.user) {
    btn.classList.add('hidden');
    box.classList.remove('hidden');
    nameEl.textContent = `${authState.user.name}(${authState.user.user_id})님`;
  } else {
    btn.classList.remove('hidden');
    box.classList.add('hidden');
  }
}

// 세션 유지 (Hearbeat)
let heartbeatInterval = null;

function startHeartbeat() {
  if(heartbeatInterval) return; // 중복 방지 실패 

  heartbeatInterval = setInterval(async () => {
    //로그인 상태가 아닐 때는 신호를 보내지 않음
    if (!authState.user) return;

    try{
      const response = await fetch('/api/auth/heartbeat', {method: 'POST'});

      //세션이 이미 만료된 경우 (401등)
      if(!response.ok) {
        console.warn('세션이 만료되었습니다');
        authState.user = null;
        renderAuthUI(); //ui를 미로그인 상태로 변경
      }
    }catch (error){
      console.error('Heartbeat 신호 전송 실패', error);
    }
  }, 3 * 60 * 1000); //3분주기
}

document.addEventListener('visibilitychange', () => {
  // 사용자가 다시 이 탭을 바라보았을 때
  if (document.visibilityState === 'visible' && authState.user) {
    fetch('api/auth/heartbeat', { method: 'POST' });
  }
});

//페이지 로드 완료시 실행
document.addEventListener('DOMContentLoaded' , () => {
  startHeartbeat();
});

// 오버레이 열기 — mode: 'login' | 'register'
function openAuthOverlay(mode = 'login', notice) {
  const ov = document.getElementById('auth-overlay');
  ov.classList.remove('hidden');
  toggleAuthForm(mode);
  const sub = document.getElementById('auth-sub');
  if (sub) sub.textContent = notice || '이력서 관리를 이용하려면 로그인하세요';
  const first = mode === 'register' ? 'rg-name' : 'li-id';
  document.getElementById(first)?.focus();
}

function closeAuthOverlay() {
  document.getElementById('auth-overlay').classList.add('hidden');
  clearAuthMsg();
}

// 로그인 폼 ⇄ 회원가입 폼 전환
function toggleAuthForm(mode) {
  document.getElementById('auth-login-form').classList.toggle('hidden', mode !== 'login');
  document.getElementById('auth-register-form').classList.toggle('hidden', mode !== 'register');
  document.getElementById('auth-title').textContent = mode === 'register' ? '회원가입' : '로그인';
  clearAuthMsg();
}


function showAuthMsg(id, text, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
  el.hidden = !text;
}
function clearAuthMsg() {
  ['li-msg', 'rg-msg'].forEach((id) => showAuthMsg(id, '', false));
}

// 로그인 성공 공통 처리 — 헤더 갱신 + 오버레이 닫힘 + 첫 메인(대시보드) 이동
function onAuthed(user) {
  authState.user = user;
  renderAuthUI();
  closeAuthOverlay();
  viewLoaded.resume = false; // 사용자 바뀌면 이력서 뷰 초기화 (이전 사용자 데이터 잔존 방지)
  switchView('dashboard');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('li-submit');
  btn.disabled = true;
  showAuthMsg('li-msg', '로그인 중...', false);
  try {
    const user = await api('/api/auth/login', {
      method: 'POST',
      body: {
        user_id: document.getElementById('li-id').value.trim(),
        password: document.getElementById('li-pw').value,
      },
    });
    document.getElementById('li-pw').value = '';
    onAuthed(user);
  } catch (err) {
    showAuthMsg('li-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('rg-submit');
  btn.disabled = true;
  showAuthMsg('rg-msg', '가입 처리 중...', false);
  try {
    const user = await api('/api/auth/register', {
      method: 'POST',
      body: {
        name: document.getElementById('rg-name').value.trim(),
        user_id: document.getElementById('rg-id').value.trim(),
        password: document.getElementById('rg-pw').value,
      },
    });
    ['rg-name', 'rg-id', 'rg-pw'].forEach((id) => { document.getElementById(id).value = ''; });
    onAuthed(user); // 가입 성공 → 자동 로그인 → 대시보드
  } catch (err) {
    showAuthMsg('rg-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 세션 이미 없어도 무시 */ }
  authState.user = null;
  renderAuthUI();
  viewLoaded.resume = false;
  // 이력서 뷰에 남아 있었다면 벗어나기 (개인정보 화면 잔존 방지)
  const activeTab = document.querySelector('.nav-tab.active');
  if (activeTab?.dataset.view === 'resume') switchView('dashboard');
}

// 페이지 로드 시 세션 쿠키로 로그인 상태 복원 (새로고침 대응)
async function restoreAuth() {
  try {
    authState.user = await api('/api/auth/me');
  } catch {
    authState.user = null; // 401 → 미로그인
  }
  renderAuthUI();
}

function bindAuthEvents() {
  on('btn-login', 'click', () => openAuthOverlay('login'));
  on('btn-auth-close', 'click', closeAuthOverlay);
  on('btn-auth-close2', 'click', closeAuthOverlay);
  on('btn-goto-register', 'click', () => toggleAuthForm('register'));
  on('btn-goto-login', 'click', () => toggleAuthForm('login'));
  on('auth-login-form', 'submit', handleLogin);
  on('auth-register-form', 'submit', handleRegister);
  on('btn-logout', 'click', handleLogout);
  // 오버레이 바깥(어두운 배경) 클릭 시 닫기
  const ov = document.getElementById('auth-overlay');
  if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) closeAuthOverlay(); });
  // ESC 로 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ov?.classList.contains('hidden')) closeAuthOverlay();
  });
}

/* ============================================================
   🧭 라우터 (Step 6) — 탭 클릭 시 뷰 전환 + lazy 로드
   ============================================================ */
const viewLoaded = { dashboard: false, insights: false, custom: false, resume: false };

function switchView(name) {
  // Step 8: 이력서 관리는 로그인 필수 — 미로그인이면 로그인 화면을 띄우고 진입 차단
  if (name === 'resume' && !authState.user) {
    openAuthOverlay('login', '🔒 이력서 관리는 로그인이 필요합니다. 내 이력서를 안전하게 보호합니다.');
    return;
  }
  document.querySelectorAll('.nav-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('active', v.dataset.view === name));
  // 해당 뷰가 처음 열리면 데이터 로드 (lazy)
  if (name === 'insights' && !viewLoaded.insights) { viewLoaded.insights = true; renderInsightsView(); }
  if (name === 'custom' && !viewLoaded.custom) { viewLoaded.custom = true; renderCustomView(); }
  if (name === 'resume' && !viewLoaded.resume) { viewLoaded.resume = true; renderResumeView(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   📊 뷰1: 대시보드 (기존 로직 유지)
   ============================================================ */
async function renderSummary() {
  const s = await api(`/api/summary${filterQS()}`);
  document.getElementById('stat-postings').textContent = fmt(s.totalPostings);
  document.getElementById('stat-recruits').textContent = fmt(s.totalRecruits);
  document.getElementById('stat-new').textContent = fmt(s.newCount ?? 0);
  document.getElementById('stat-exp').textContent = fmt(s.expCount ?? 0);

  const dot = document.getElementById('status-dot');
  const run = document.getElementById('last-run');
  if (s.lastRun?.status === 'success') {
    dot.dataset.state = 'ok';
    run.textContent = fmtRun(s.lastRun.run_at);
  } else if (s.lastRun?.status && s.lastRun.status !== 'success') {
    dot.dataset.state = 'error';
    run.textContent = `수집 ${s.lastRun.status} · ${fmtRun(s.lastRun.run_at)}`;
  } else {
    dot.dataset.state = 'loading';
    run.textContent = '데이터 없음';
  }
  if (!s.totalPostings) showEmptyDataBanner();
}

function showEmptyDataBanner() {
  const card = document.getElementById('insight-card');
  if (card) {
    document.getElementById('insight-text').textContent =
      '아직 수집된 채용공고가 없습니다. 잠시 후 자동 수집이 진행되면 데이터가 채워집니다.';
  }
}

async function renderInsight() {
  try {
    const d = await api(`/api/insight/weekly${filterQS()}`);
    const el = document.getElementById('insight-text');
    if (!d.stats?.total) {
      el.textContent = '해당 조건의 채용공고가 없습니다. 필터를 조금 넓혀보세요.';
      return;
    }
    el.textContent = d.insight || '요약을 생성하지 못했습니다.';
  } catch {
    document.getElementById('insight-text').textContent = '트렌드 요약을 불러오지 못했습니다.';
  }
}

async function renderCategoryChart() {
  const data = await api(`/api/trends/category${filterQS()}`);
  const top = data.slice(0, 10);
  if (!top.length) return showEmpty('chart-category', '해당 조건의 데이터가 없습니다.');
  hideEmpty('chart-category');
  setChart('chart-category', {
    type: 'bar',
    data: {
      labels: top.map((d) => trim(d.name, 10)),
      datasets: [{
        data: top.map((d) => d.c),
        backgroundColor: top.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderRadius: 6, maxBarThickness: 30,
      }],
    },
    options: barOpts('공고 수'),
  });
}

async function renderRegionChart() {
  const data = await api(`/api/trends/region${filterQS()}`);
  const sub = document.getElementById('region-sub');
  if (sub) sub.textContent = state.region ? `${state.region} 내 시·군·구` : '시·도 기준';
  const top = data.slice(0, 8);
  if (!top.length) return showEmpty('chart-region', '해당 조건의 데이터가 없습니다.');
  hideEmpty('chart-region');
  setChart('chart-region', {
    type: 'doughnut',
    data: {
      labels: top.map((d) => d.name),
      datasets: [{
        data: top.map((d) => d.c),
        backgroundColor: top.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderColor: '#ffffff', borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: doughnutOpts(),
  });
}

async function renderCareerChart() {
  const d = await api(`/api/trends/experience${filterQS()}`);
  const data = d.career || [];
  if (!data.length) return showEmpty('chart-career', '해당 조건의 데이터가 없습니다.');
  hideEmpty('chart-career');
  setChart('chart-career', {
    type: 'doughnut',
    data: {
      labels: data.map((x) => x.name),
      datasets: [{
        data: data.map((x) => x.c),
        backgroundColor: ['#1f9d6b', '#2f7fd1', '#6a5cff', '#c98a1a', '#d96aa5', '#76888f'],
        borderColor: '#ffffff', borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: doughnutOpts(),
  });
}

async function renderEducationChart() {
  const d = await api(`/api/trends/experience${filterQS()}`);
  const data = (d.education || []).slice(0, 8);
  if (!data.length) return showEmpty('chart-education', '해당 조건의 데이터가 없습니다.');
  hideEmpty('chart-education');
  setChart('chart-education', {
    type: 'bar',
    data: {
      labels: data.map((x) => trim(x.raw || x.name, 10)),
      datasets: [{
        data: data.map((x) => x.c),
        backgroundColor: data.map((_, i) => CHART_COLORS[(i + 2) % CHART_COLORS.length]),
        borderRadius: 6, maxBarThickness: 30,
      }],
    },
    options: barOpts('모집직무 수'),
  });
}

async function renderTypeChart() {
  const d = await api(`/api/trends/type${filterQS()}`);
  const data = (d.employmentType || []).filter((x) => x.name);
  if (!data.length) return showEmpty('chart-type', '해당 조건의 데이터가 없습니다.');
  hideEmpty('chart-type');
  setChart('chart-type', {
    type: 'bar',
    data: {
      labels: data.map((x) => x.name),
      datasets: [{
        data: data.map((x) => x.c),
        backgroundColor: ['#1f9d6b', '#2f7fd1', '#76888f'],
        borderRadius: 6, maxBarThickness: 26,
      }],
    },
    options: hBarOpts('공고 수'),
  });
}

function barOpts(yTitle, chartTitle) {
  const plugins = { legend: { display: false }, tooltip: tooltipWithCount() };
  if (chartTitle) plugins.title = { display: true, text: chartTitle, color: '#3a4750', font: { size: 13, weight: '700' } };
  return {
    responsive: true, maintainAspectRatio: false, plugins,
    scales: {
      x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 } },
      y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.06)' }, ticks: { precision: 0 }, title: { display: true, text: yTitle, color: '#6b7488', font: { size: 11 } } },
    },
  };
}
function hBarOpts() {
  return {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: tooltipWithCount() },
    scales: {
      x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.06)' }, ticks: { precision: 0 } },
      y: { grid: { display: false } },
    },
  };
}
function doughnutOpts(chartTitle) {
  const plugins = {
    legend: { position: 'right', labels: { usePointStyle: true } },
    tooltip: tooltipWithCount(),
  };
  if (chartTitle) plugins.title = { display: true, text: chartTitle, color: '#3a4750', font: { size: 13, weight: '700' } };
  return { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins };
}
function tooltipWithCount() {
  return {
    callbacks: {
      label(ctx) {
        const v = ctx.parsed.y ?? ctx.parsed ?? 0;
        const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
        const p = total ? ((v / total) * 100).toFixed(1) : 0;
        return `  ${fmt(v)}건 (${p}%)`;
      },
      title(items) { return items[0].label; },
    },
  };
}

async function renderPostings() {
  const list = document.getElementById('postings-list');
  list.innerHTML = '<div class="loading">불러오는 중…</div>';
  document.getElementById('list-count').textContent = '';

  const params = new URLSearchParams({ page: state.page, size: state.size });
  if (state.company) params.set('companyType', state.company);
  if (state.region) params.set('region', state.region);
  if (state.category) params.set('category', state.category);
  if (state.itOnly) params.set('itOnly', '1');

  try {
    const d = await api(`/api/postings?${params}`);
    document.getElementById('list-count').textContent = `총 ${fmt(d.total)}건`;
    renderPager(d, 'pager-info', 'pager-prev', 'pager-next', state);
    if (!d.items.length) {
      list.innerHTML = '<div class="loading">해당 조건의 공고가 없습니다.</div>';
      return;
    }
    list.innerHTML = d.items.map((p) => postingHTML(p)).join('');
    bindLogoFallback(list);
  } catch (e) {
    list.innerHTML = `<div class="err-box">공고를 불러오지 못했습니다.<br><small>${escapeHTML(e.message)}</small></div>`;
    renderPager({ total: 0, page: state.page, size: state.size }, 'pager-info', 'pager-prev', 'pager-next', state);
  }
}

function postingHTML(p, matchTags = []) {
  const co = escapeHTML(p.company_name || '회사명 미정');
  const title = escapeHTML(p.title || '채용공고');
  const cat = p.job_category ? `<span class="tag ${matchTags.includes('it') ? 'match' : ''}">${escapeHTML(p.job_category)}</span>` : '';
  const coType = p.company_type ? `<span class="tag neutral">${escapeHTML(p.company_type)}</span>` : '';
  const emp = p.employment_type ? `<span>${escapeHTML(p.employment_type)}</span>` : '';
  const term = (p.start_dt || p.end_dt) ? `<span>${escapeHTML(formatTerm(p.start_dt, p.end_dt))}</span>` : '';
  const logo = p.logo_url
    ? `<img class="posting-logo" src="${escapeAttr(p.logo_url)}" alt="" loading="lazy" />`
    : `<div class="posting-logo fallback">${escapeHTML((p.company_name || '?').slice(0, 1))}</div>`;
  const href = p.source_url
    ? escapeAttr(p.source_url)
    : `${BASE}api/postings/${encodeURIComponent(p.emp_seqno)}/goto`;
  return `<a class="posting" href="${href}" target="_blank" rel="noopener noreferrer">
    ${logo}
    <div class="posting-main">
      <p class="posting-title">${title}</p>
      <div class="posting-meta">${coType}${cat}${emp}${term}<span>${co}</span></div>
    </div>
    <span class="posting-go">지원하기</span>
  </a>`;
}

function formatTerm(s, e) {
  const f = (d) => d && d.length === 8 ? `${d.slice(2, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : '';
  if (s && e) return `${f(s)} ~ ${f(e)}`;
  return f(s) || f(e) || '';
}

function bindLogoFallback(list) {
  list.querySelectorAll('img.posting-logo').forEach((img) => {
    img.addEventListener('error', () => {
      const fb = document.createElement('div');
      fb.className = 'posting-logo fallback';
      fb.textContent = '?';
      img.replaceWith(fb);
    });
  });
}

// 범용 페이저 렌더 (뷰1/뷰3 재사용)
function renderPager(d, infoId, prevId, nextId, st) {
  const total = d.total || 0;
  const pages = Math.max(1, Math.ceil(total / st.size));
  document.getElementById(infoId).textContent = `${st.page} / ${pages}`;
  document.getElementById(prevId).disabled = st.page <= 1;
  document.getElementById(nextId).disabled = st.page >= pages;
}

async function fillFilterOptions() {
  const itQ = state.itOnly ? '&itOnly=1' : '';
  const type = await api('/api/trends/type');
  fillSelect('f-company', type.companyType.filter((x) => x.name));
  const region = await api(`/api/trends/region?period=all${itQ}`);
  fillSelect('f-region', region.slice(0, 15));
  const cat = await api(`/api/trends/category?period=all${itQ}`);
  fillSelect('f-category', cat.slice(0, 20));
}
function fillSelect(id, rows) {
  const sel = document.getElementById(id);
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  rows.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.name; opt.textContent = `${r.name} (${fmt(r.c)})`;
    sel.appendChild(opt);
  });
}

function bindDashboardEvents() {
  on('f-period', 'change', (e) => { state.period = e.target.value; state.page = 1; refreshAll(); });
  ['f-company', 'f-region', 'f-category'].forEach((id) => {
    on(id, 'change', (e) => {
      if (id === 'f-company') state.company = e.target.value;
      if (id === 'f-region') state.region = e.target.value;
      if (id === 'f-category') state.category = e.target.value;
      state.page = 1;
      renderPostings();
      refreshAll();
    });
  });
  on('f-it', 'change', async (e) => {
    state.itOnly = e.target.checked;
    state.category = ''; state.region = ''; state.page = 1;
    const c = document.getElementById('f-category'); if (c) c.value = '';
    const r = document.getElementById('f-region'); if (r) r.value = '';
    try { await fillFilterOptions(); } catch {}
    renderPostings();
    refreshAll();
  });
  on('pager-prev', 'click', () => { if (state.page > 1) { state.page--; renderPostings(); } });
  on('pager-next', 'click', () => { state.page++; renderPostings(); });
}

async function refreshTrends() {
  await Promise.allSettled([
    renderCategoryChart(), renderRegionChart(), renderCareerChart(),
    renderEducationChart(), renderTypeChart(),
  ]);
}
async function refreshAll() {
  await Promise.allSettled([
    renderSummary().catch(() => {
      document.getElementById('status-dot').dataset.state = 'error';
      document.getElementById('last-run').textContent = '데이터를 불러오지 못했습니다';
    }),
    renderInsight(),
    refreshTrends(),
  ]);
}

/* ============================================================
   💡 뷰2: 인사이트 페이지 (C·D·F) — IT/개발 직군 중심
   ============================================================ */
async function renderInsightsView() {
  try {
    // 전체 vs IT 데이터 병렬 수집 (이름 = 실제 API 의미 일치)
    const [allSum, itSum, allExp, itExp, itReg, allType, itType, trend] = await Promise.all([
      api('/api/summary'),                        // 전체 요약
      api('/api/summary?itOnly=1'),               // IT 요약
      api('/api/trends/experience'),              // 전체 경력/학력
      api('/api/trends/experience?itOnly=1'),     // IT/개발 경력/학력
      api('/api/trends/region?itOnly=1'),         // IT 지역
      api('/api/trends/type'),                    // 전체 고용형태
      api('/api/trends/type?itOnly=1'),           // IT 고용형태
      api('/api/insight/trend?itOnly=1'),         // IT 흐름 비교 (스냅샷 기반)
    ]);
    renderInsightCareer(itExp);
    renderInsightRegion(itReg);
    renderInsightCompare(allSum, itSum, allExp, itExp, allType, itType);
    renderInsightTrend(trend);

    // 안내 문구의 표본 건수를 현재 IT/개발 모집직무 수로 실시간 반영 (정적 "31건" 고정 제거)
    const sampleEl = document.getElementById('ins-sample-count');
    if (sampleEl) sampleEl.textContent = (itSum.totalRecruits || 0).toLocaleString();
  } catch {
    document.getElementById('ins-text-career').textContent = '인사이트 데이터를 불러오지 못했습니다.';
  }
}

// C. 경력·학력 (IT)
function renderInsightCareer(itExp) {
  const career = itExp.career || [];
  const edu = itExp.education || [];
  const newC = career.find((x) => x.name === '신입')?.c || 0;
  const internC = career.find((x) => x.name === '인턴')?.c || 0;
  const expC = career.find((x) => x.name === '경력')?.c || 0;
  const bothC = career.find((x) => x.name === '경력+신입')?.c || 0;
  const newAvail = newC + internC + bothC;
  const careerTotal = career.reduce((a, b) => a + b.c, 0) || 1;

  const cards = [
    { v: newAvail + '건', l: '신입 지원 가능 IT/개발 모집직무', hi: true },
    { v: pct(newAvail, careerTotal) + '%', l: 'IT/개발 중 신입 가능 비중' },
    { v: (expC + bothC) + '건', l: '경력 대상' },
  ];
  document.getElementById('ins-cards-career').innerHTML =
    cards.map((c) => `<div class="ins-stat ${c.hi ? 'hi' : ''}"><div class="v">${c.v}</div><div class="l">${c.l}</div></div>`).join('');

  if (career.length) {
    setChart('chart-ins-career', {
      type: 'doughnut',
      data: {
        labels: career.map((x) => x.name),
        datasets: [{
          data: career.map((x) => x.c),
          backgroundColor: ['#1f9d6b', '#2f7fd1', '#6a5cff', '#c98a1a', '#d96aa5', '#76888f'],
          borderColor: '#fff', borderWidth: 2, hoverOffset: 6,
        }],
      },
      options: doughnutOpts('IT/개발 경력 요건'),
    });
  }
  if (edu.length) {
    const eduTop = edu.slice(0, 6);
    setChart('chart-ins-edu', {
      type: 'bar',
      data: {
        labels: eduTop.map((x) => trim(x.raw || x.name, 8)),
        datasets: [{ data: eduTop.map((x) => x.c), backgroundColor: '#6a5cff', borderRadius: 6, maxBarThickness: 26 }],
      },
      options: barOpts('모집직무 수', 'IT/개발 학력 요건'),
    });
  }

  const msg = newAvail > (expC + bothC)
    ? `현재 IT/개발 직군은 <strong>신입 채용이 활발</strong>합니다. 신입 가능 모집직무 ${newAvail}건으로 경력 대상(${expC + bothC}건)보다 많습니다. 단, R&D·연구 직무가 섞여 석·박사 학력 요건 비중도 높은 편입니다.`
    : `현재 IT/개발 직군은 경력 수요가 더 많은 편입니다. (경력 ${expC + bothC}건 vs 신입 가능 ${newAvail}건)`;
  document.getElementById('ins-text-career').innerHTML = msg;
}

// D. 지역 (IT)
function renderInsightRegion(itReg) {
  const top = (itReg || []).slice(0, 8);
  const seoul = top.find((x) => x.name === '서울')?.c || 0;
  const ggi = top.find((x) => x.name === '경기')?.c || 0;
  const total = top.reduce((a, b) => a + b.c, 0) || 1;
  const capital = seoul + ggi;
  const others = total - capital;

  document.getElementById('ins-cards-region').innerHTML = [
    { v: pct(seoul, total) + '%', l: '서울 집중도', hi: true },
    { v: pct(capital, total) + '%', l: '수도권(서울·경기)' },
    { v: pct(others, total) + '%', l: '비수도권' },
  ].map((c) => `<div class="ins-stat ${c.hi ? 'hi' : ''}"><div class="v">${c.v}</div><div class="l">${c.l}</div></div>`).join('');

  if (top.length) {
    setChart('chart-ins-region', {
      type: 'bar',
      data: {
        labels: top.map((x) => x.name),
        datasets: [{ data: top.map((x) => x.c), backgroundColor: '#2f7fd1', borderRadius: 6, maxBarThickness: 34 }],
      },
      options: barOpts('IT/개발 모집직무 수'),
    });
  }

  const msg = seoul / total > 0.4
    ? `IT/개발 직군 채용은 <strong>서울에 강하게 집중</strong>되어 있습니다 (서울 ${pct(seoul, total)}%, 수도권 ${pct(capital, total)}%). 지방 거주자라면 수도권 이직·재직 조건을 고려해야 할 가능성이 높습니다.`
    : `IT/개발 직군 채용은 수도권과 지방이 비교적 고르게 분포합니다. (수도권 ${pct(capital, total)}%)`;
  document.getElementById('ins-text-region').innerHTML = msg;
}

// F. 전체 vs IT 비교
function renderInsightCompare(allSum, itSum, allExp, itExp, allType, itType) {
  const eduGradCount = (e) => (e.education || []).filter((x) => /석사|박사/.test(x.raw || x.name)).reduce((a, b) => a + b.c, 0);
  const itGrad = eduGradCount(itExp);
  const allGrad = eduGradCount(allExp);
  const itRecruits = itSum.totalRecruits || 1;
  const allRecruits = allSum.totalRecruits || 1;

  const regularCount = (t) => (t.employmentType || []).filter((x) => x.name === '정규직').reduce((a, b) => a + b.c, 0);
  const itRegular = regularCount(itType);
  const allRegular = regularCount(allType);
  const itPosts = itSum.totalPostings || 1;
  const allPosts = allSum.totalPostings || 1;

  const rows = [
    { title: '학력 요건 (석·박사 비중)', it: `${pct(itGrad, itRecruits)}%`, all: `${pct(allGrad, allRecruits)}%` },
    { title: '정규직 비중 (공고 기준)', it: `${pct(itRegular, itPosts)}%`, all: `${pct(allRegular, allPosts)}%` },
    { title: '총 공고 수', it: fmt(itSum.totalPostings), all: fmt(allSum.totalPostings) },
    { title: '신입 가능 모집직무', it: fmt(itSum.newCount), all: fmt(allSum.newCount) },
  ];
  document.getElementById('compare-grid').innerHTML = rows.map((r) => `
    <div class="compare-card">
      <div class="title">${r.title}</div>
      <div class="compare-row it"><span class="lab">IT/개발 직군</span><span class="val">${r.it}</span></div>
      <div class="compare-row all"><span class="lab">전체 평균</span><span class="val">${r.all}</span></div>
    </div>`).join('');

  const gradDiff = pct(itGrad, itRecruits) - pct(allGrad, allRecruits);
  const msg = gradDiff > 5
    ? `<strong>IT/개발 직군은 전체 평균보다 학력 요건이 높습니다.</strong> (석·박사 비중 ${pct(itGrad, itRecruits)}% vs 전체 ${pct(allGrad, allRecruits)}%). R&D·연구 개발 직무 비중이 커서 고학력 요구가 뚜렷합니다.`
    : `IT/개발 직군과 전체의 학력 요건은 비슷한 편입니다. (석·박사 IT/개발 ${pct(itGrad, itRecruits)}% vs 전체 ${pct(allGrad, allRecruits)}%)`;
  document.getElementById('ins-text-compare').innerHTML = msg;
}

/* ============================================================
   🎯 뷰3: 맞춤 공고 (G) — 내 조건 + 매칭
   ============================================================ */
const customState = {
  region: '', category: '',
  isNew: false, eduNone: false, regular: false, itOnly: false,
  page: 1, size: 12,
};
const CUSTOM_STORE_KEY = 'jmr-custom-cond';

function customQS() {
  const p = new URLSearchParams({ page: customState.page, size: customState.size });
  if (customState.region) p.set('region', customState.region);
  if (customState.category) p.set('category', customState.category);
  if (customState.isNew) p.set('career', '신입');
  if (customState.itOnly) p.set('itOnly', '1');
  if (customState.eduNone) p.set('eduNone', '1');   // 학력무관(미기재) 모집직무 있는 공고
  if (customState.regular) p.set('regular', '1');   // 정규직(전환형 포함) 공고
  return p.toString();
}

async function renderCustomView() {
  loadCustomCond(); // 저장 조건 복원
  // 맞춤 페이지 옵션 채우기 (전체 기준)
  try {
    const [region, cat] = await Promise.all([
      api('/api/trends/region?period=all'),
      api('/api/trends/category?period=all'),
    ]);
    fillSelect('c-region', region.slice(0, 15));
    fillSelect('c-category', cat.slice(0, 20));
  } catch {}
  restoreCustomUI();
  await renderCustomPostings();
}

async function renderCustomPostings() {
  const list = document.getElementById('custom-list');
  list.innerHTML = '<div class="loading">불러오는 중…</div>';
  document.getElementById('custom-count').textContent = '';
  try {
    const d = await api(`/api/postings?${customQS()}`);
    const matchTags = customState.itOnly ? ['it'] : [];
    document.getElementById('custom-count').textContent = `총 ${fmt(d.total)}건`;
    if (!d.items.length) {
      list.innerHTML = '<div class="loading">조건에 맞는 공고가 없습니다. 조건을 넓혀보세요.</div>';
      renderPager({ total: 0, page: customState.page, size: customState.size }, 'c-info', 'c-prev', 'c-next', customState);
      return;
    }
    list.innerHTML = d.items.map((p) => postingHTML(p, matchTags)).join('');
    bindLogoFallback(list);
    renderPager(d, 'c-info', 'c-prev', 'c-next', customState);
  } catch {
    list.innerHTML = '<div class="err-box">공고를 불러오지 못했습니다.</div>';
  }
}

function bindCustomEvents() {
  on('c-region', 'change', (e) => { customState.region = e.target.value; customState.page = 1; saveCustomCond(); renderCustomPostings(); });
  on('c-category', 'change', (e) => { customState.category = e.target.value; customState.page = 1; saveCustomCond(); renderCustomPostings(); });
  ['c-new', 'c-edu-none', 'c-regular', 'c-it'].forEach((id) => {
    on(id, 'change', (e) => {
      const key = id === 'c-new' ? 'isNew' : id === 'c-edu-none' ? 'eduNone' : id === 'c-regular' ? 'regular' : 'itOnly';
      customState[key] = e.target.checked; customState.page = 1; saveCustomCond(); renderCustomPostings();
    });
  });
  on('c-prev', 'click', () => { if (customState.page > 1) { customState.page--; renderCustomPostings(); } });
  on('c-next', 'click', () => { customState.page++; renderCustomPostings(); });
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
}

function applyPreset(name) {
  // 초기화 후 preset 적용
  customState.region = ''; customState.category = '';
  customState.isNew = false; customState.eduNone = false; customState.regular = false; customState.itOnly = false;
  if (name === 'seoul-new') { customState.region = '서울'; customState.isNew = true; customState.regular = true; }
  else if (name === 'intern') { customState.eduNone = true; }
  else if (name === 'it-any') { customState.itOnly = true; }
  customState.page = 1;
  restoreCustomUI();
  saveCustomCond();
  renderCustomPostings();
}

function restoreCustomUI() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  set('c-region', customState.region); set('c-category', customState.category);
  chk('c-new', customState.isNew); chk('c-edu-none', customState.eduNone);
  chk('c-regular', customState.regular); chk('c-it', customState.itOnly);
}

function saveCustomCond() {
  try { localStorage.setItem(CUSTOM_STORE_KEY, JSON.stringify({
    region: customState.region, category: customState.category,
    isNew: customState.isNew, eduNone: customState.eduNone, regular: customState.regular, itOnly: customState.itOnly,
  })); } catch {}
}
function loadCustomCond() {
  try {
    const s = JSON.parse(localStorage.getItem(CUSTOM_STORE_KEY) || 'null');
    if (s) Object.assign(customState, s);
  } catch {}
}

/* ---------------- 유틸 ---------------- */
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHTML(s); }

/* ============================================================
   G. 흐름 비교 (수집 시점 스냅샷 — 과거 vs 현재 직종 증감)
   ============================================================ */
function fmtRunAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderInsightTrend(data) {
  const cards = document.getElementById('trend-cards');
  const diffEl = document.getElementById('trend-diff');
  const note = document.getElementById('trend-note');
  const text = document.getElementById('ins-text-trend');
  const tl = (data && data.timeline) || [];
  const isIT = (data && data.scope) === 'it';
  // 단위: 서버가 내려주는 data.unit(모집직무/공고) 우선. fallback 스냅샷은 '공고' 단위.
  const baseUnit = (data && data.unit) || '모집직무';
  const unit = isIT ? `IT/개발 ${baseUnit}` : baseUnit;

  // 스냅샷이 없거나 1개뿐 → 비교 불가 안내
  if (!data || !data.current || !data.hasCompare) {
    if (cards) cards.innerHTML = tl.length
      ? `<div class="ins-stat hi"><div class="v">${fmt(tl[tl.length - 1].total)}건</div><div class="l">현재 ${unit} (기준점)</div></div>`
      : '';
    if (diffEl) diffEl.innerHTML = '';
    if (note) note.textContent = isIT
      ? '다음 수집(내일)부터 IT/개발 직군의 변화를 비교할 수 있어요. 지금은 첫 기준점만 저장된 상태입니다.'
      : '다음 수집(내일)부터 변화를 비교할 수 있어요. 지금은 첫 기준점만 저장된 상태입니다.';
    if (text) text.textContent = '';
    drawTrendTotalChart(tl, isIT, baseUnit);
    return;
  }

  const { summary, current, previous } = data;
  // 카드: 모집직무 순증감 / 증가 직종 수 / 감소 직종 수 (단위 명시)
  cards.innerHTML = [
    { v: (summary.netDelta >= 0 ? '+' : '') + summary.netDelta + '건', l: `${unit} 순 증감`, hi: summary.netDelta >= 0 },
    { v: '+' + summary.upCount, l: `${baseUnit} 늘어난 직종` },
    { v: '−' + summary.downCount, l: `${baseUnit} 줄어든 직종` },
  ].map((c) => `<div class="ins-stat ${c.hi ? 'hi' : ''}"><div class="v">${c.v}</div><div class="l">${c.l}</div></div>`).join('');

  if (note) {
    const span = current.run_at
      ? `비교 구간: <strong>${fmtRunAt(previous.run_at)} → ${fmtRunAt(current.run_at)}</strong> 수집 · ${unit} <strong>${previous.total} → ${current.total}건</strong>`
      : '';
    note.innerHTML = span;
  }

  // 증감 리스트 (변화 큰 순) — 절대값 + % 함께 표시
  const rows = (data.diff || []).slice(0, 12);
  if (rows.length) {
    diffEl.innerHTML = `<div class="trend-diff-title">IT/개발 직종별 ${baseUnit} 증감 (변화 큰 순 ${rows.length}개)</div>` +
      `<div class="trend-bars">${rows.map((r) => {
        const up = r.delta > 0;
        const maxAbs = Math.max(...rows.map((x) => Math.abs(x.delta)), 1);
        const w = Math.round((Math.abs(r.delta) / maxAbs) * 100);
        const pctStr = (r.pct > 0 ? '+' : '') + r.pct + '%';
        return `<div class="trend-bar-row">
          <span class="trend-name" title="${escapeAttr(r.name)}">${escapeHTML(trim(r.name, 22))}</span>
          <span class="trend-track ${up ? 'up' : 'down'}">
            <span class="trend-fill ${up ? 'up' : 'down'}" style="width:${w}%"></span>
          </span>
          <span class="trend-delta ${up ? 'up' : 'down'}" title="이전 ${r.prev}건 → 현재 ${r.curr}건">
            ${up ? '▲' : '▼'} ${Math.abs(r.delta)}건 <span class="trend-pct">(${pctStr})</span>
          </span>
        </div>`;
      }).join('')}</div>`;
  } else {
    diffEl.innerHTML = '<div class="insight-text">이번 비교 구간엔 IT/개발 직종별 유의미한 변화가 없습니다.</div>';
  }

  // 인사이트 텍스트 — 증감 폭이 큰 직종으로 서사 생성
  const topUp = (data.diff || []).find((r) => r.delta > 0);
  const topDown = (data.diff || []).find((r) => r.delta < 0);
  const parts = [`지난 수집(${fmtRunAt(previous.run_at)}) 대비 ${unit}가 ${summary.netDelta >= 0 ? '+' : ''}${summary.netDelta}건 변동했습니다.`];
  if (topUp) parts.push(`가장 많이 늘어난 IT/개발 직종은 <strong>"${escapeHTML(topUp.name)}"(+${topUp.delta}건, ${topUp.pct >= 0 ? '+' : ''}${topUp.pct}%)</strong>`);
  if (topDown) parts.push(`가장 많이 줄어든 IT/개발 직종은 <strong>"${escapeHTML(topDown.name)}"(${topDown.delta}건, ${topDown.pct}%)</strong>입니다.`);
  if (!topUp && !topDown) parts.push('이번 구간엔 IT/개발 직종에 뚜렷한 증감이 없습니다.');
  parts.push('※ 워크넷 등록 공고 기준이며, 마감 공고가 반영되므로 절대적 규모보다 흐름(방향) 참고용입니다.');
  text.innerHTML = parts.join(' ');

  drawTrendTotalChart(tl, isIT, baseUnit);
}

// G 보조: IT/개발 모집직무 수 시계열 라인 차트
function drawTrendTotalChart(tl, isIT, baseUnit = '모집직무') {
  const el = document.getElementById('chart-trend-total');
  if (!el || tl.length === 0) return;
  const label = isIT ? `IT/개발 ${baseUnit} 수` : `전체 ${baseUnit} 수`;
  setChart('chart-trend-total', {
    type: 'line',
    data: {
      labels: tl.map((p) => fmtRunAt(p.run_at)),
      datasets: [{
        label,
        data: tl.map((p) => p.total),
        borderColor: '#2f7fd1',
        backgroundColor: 'rgba(47,127,209,.14)',
        fill: true, tension: 0.3,
        pointRadius: tl.length > 1 ? 4 : 5,
        pointBackgroundColor: '#2f7fd1',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `  ${label}: ${fmt(c.parsed.y)}건` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: false, grid: { color: 'rgba(0,0,0,.06)' }, ticks: { precision: 0, callback: (v) => fmt(v) + '건' } },
      },
    },
  });
}

/* ============================================================
   📝 뷰4: 이력서 관리 (Step 7) — 다중 프로필 + AI 자기소개서
   ============================================================ */
const resumeState = {
  profiles: [], currentProfileId: null, editingProfileId: null,
  targetJobs: [], currentLetterId: null,
  // ★ Step 9: 요구사항 번들 (에디터 내 소스 선택에서 채움)
  req: null,          // { company, position, duties[], required[], preferred[], notes[], meta:{source,...} }
  reqMeta: null,      // 저장용 부가정보 { req_source, req_posting_id, req_url, req_text }
};

/* ============================================================
   📋 Step 9: 채용공고 요구사항 — 에디터 내 3탭 (db/url/paste)
   ============================================================ */
const REQ_SOURCE_LABEL = { db: 'DB 공고', url: 'URL 분석', paste: '직접 붙여넣기' };

// 번들 → 미리보기 카드 렌더 (수정 가능한 textarea)
function renderReqPreview() {
  const box = document.getElementById('req-preview');
  const badge = document.getElementById('req-badge');
  const req = resumeState.req;
  if (!req) {
    box.classList.add('hidden');
    badge.hidden = true;
    return;
  }
  box.classList.remove('hidden');
  badge.hidden = false;
  badge.textContent = '✓ 설정됨';
  document.getElementById('req-preview-title').textContent =
    [req.company, req.position].filter(Boolean).join(' · ') || '요구사항';
  document.getElementById('req-source-tag').textContent =
    REQ_SOURCE_LABEL[req.meta?.source] || req.meta?.source || '';
  document.getElementById('req-edit-duties').value = (req.duties || []).join('\n');
  document.getElementById('req-edit-required').value = (req.required || []).join('\n');
  document.getElementById('req-edit-preferred').value = (req.preferred || []).join('\n');
  document.getElementById('req-edit-notes').value = (req.notes || []).join('\n');
}

// 미리보기 카드의 수정 내용 → state 반영 (생성 직전 호출)
function collectReqFromPreview() {
  const req = resumeState.req;
  if (!req) return;
  const lines = (id) => document.getElementById(id).value.split('\n')
    .map((l) => l.trim()).filter(Boolean);
  req.duties = lines('req-edit-duties');
  req.required = lines('req-edit-required');
  req.preferred = lines('req-edit-preferred');
  req.notes = lines('req-edit-notes');
}

function clearReq() {
  resumeState.req = null;
  resumeState.reqMeta = null;
  renderReqPreview();
  ['rq-db-query', 'rq-url-input', 'rq-paste-input'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  const res = document.getElementById('rq-db-results'); if (res) res.innerHTML = '';
}

// 아코디언 토글
function toggleReqSection(open) {
  const body = document.getElementById('req-body');
  const arrow = document.getElementById('req-toggle-arrow');
  const btn = document.getElementById('req-toggle');
  const willOpen = open !== undefined ? open : body.classList.contains('hidden');
  body.classList.toggle('hidden', !willOpen);
  arrow.textContent = willOpen ? '▴' : '▾';
  btn.setAttribute('aria-expanded', String(willOpen));
}

function switchReqTab(name) {
  document.querySelectorAll('.req-tab').forEach((t) => t.classList.toggle('active', t.dataset.reqTab === name));
  document.querySelectorAll('.req-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.reqPane !== name));
}

// ---- ① DB 탭: 회사명 검색 → 공고 목록 ----
async function searchDbPostings() {
  const q = document.getElementById('rq-db-query').value.trim();
  const box = document.getElementById('rq-db-results');
  if (q.length < 2) { box.innerHTML = '<p class="req-status">2자 이상 입력해주세요.</p>'; return; }
  box.innerHTML = '<p class="req-status">검색 중…</p>';
  try {
    const rows = await api(`/api/companies/search?q=${encodeURIComponent(q)}`);
    if (!rows.length) {
      box.innerHTML = '<p class="req-status">수집된 공고에 해당 회사가 없습니다.<br>② URL 가져오기 또는 ③ 붙여넣기를 사용해주세요.</p>' +
        '<button type="button" class="btn btn-sm" id="rq-goto-paste">③ 붙여넣기로 이동</button>';
      document.getElementById('rq-goto-paste')?.addEventListener('click', () => switchReqTab('paste'));
      return;
    }
    box.innerHTML = `<p class="req-status">${rows.length}건의 공고를 찾았습니다. 클릭해서 선택:</p>` +
      rows.map((r) => `
        <button type="button" class="req-posting-item" data-seqno="${escapeAttr(r.emp_seqno)}">
          <span class="rpi-title">${escapeHTML(r.title)}</span>
          <span class="rpi-meta">${escapeHTML(r.job_category || '')} · ${escapeHTML(r.employment_type || '')} · 마감 ${escapeHTML((r.end_dt || '').slice(4, 6) + '/' + (r.end_dt || '').slice(6, 8))}</span>
        </button>`).join('');
    box.querySelectorAll('.req-posting-item').forEach((b) => {
      b.addEventListener('click', () => selectDbPosting(b.dataset.seqno));
    });
  } catch (e) {
    box.innerHTML = `<p class="req-status err">${escapeHTML(e.message)}</p>`;
  }
}

async function selectDbPosting(seqno) {
  const box = document.getElementById('rq-db-results');
  box.innerHTML = '<p class="req-status">요구사항 가져오는 중…</p>';
  try {
    const bundle = await api(`/api/postings/${encodeURIComponent(seqno)}/requirements`);
    resumeState.req = bundle;
    resumeState.reqMeta = { req_source: 'db', req_posting_id: String(seqno), req_url: null, req_text: null };
    renderReqPreview();
    // 회사명 칸 자동 채움 (비어있으면)
    const co = document.getElementById('re-company');
    if (co && !co.value.trim() && bundle.company) co.value = bundle.company;
    box.innerHTML = `<p class="req-status ok">✓ "${escapeHTML(bundle.position || bundle.company)}" 공고 요구사항을 가져왔습니다.</p>`;
  } catch (e) {
    box.innerHTML = `<p class="req-status err">${escapeHTML(e.message)}</p>`;
  }
}

// ---- ② URL 탭 ----
async function fetchUrlRequirements() {
  const url = document.getElementById('rq-url-input').value.trim();
  const status = document.getElementById('rq-url-status');
  if (!/^https?:\/\//.test(url)) {
    status.hidden = false; status.className = 'req-status err'; status.textContent = 'http(s)로 시작하는 URL을 입력해주세요.';
    return;
  }
  status.hidden = false; status.className = 'req-status'; status.textContent = '🌐 공고 페이지 읽는 중… (사람인은 원문 그대로 수 초, 그 외 사이트는 최대 90초)';
  try {
    const r = await api('/api/ai/fetch-url', { method: 'POST', body: { url } });
    resumeState.req = r.bundle;
    resumeState.reqMeta = { req_source: 'url', req_posting_id: null, req_url: url, req_text: null };
    renderReqPreview();
    const co = document.getElementById('re-company');
    if (co && !co.value.trim() && r.bundle.company) co.value = r.bundle.company;
    status.className = 'req-status ok'; status.textContent = '✓ 요구사항을 가져왔습니다.';
  } catch (e) {
    status.className = 'req-status err';
    // 과부하는 일시 장애 — 붙여넣기 전환 없이 잠시 후 재시도 안내만
    if (isAiBusyError(e)) {
      status.textContent = '⚠ ' + (e.serverMsg || e.message);
      return;
    }
    status.innerHTML = escapeHTML(e.message) + '<br>→ <strong>③ 붙여넣기</strong>로 공고 내용을 직접 넣어주세요.';
    // 실패 시 붙여넣기 탭으로 자동 전환 (요구사항 없을 때만)
    if (!resumeState.req) {
      switchReqTab('paste');
      document.getElementById('rq-paste-input')?.focus();
    }
  }
}

// ---- ③ 붙여넣기 탭 ----
async function analyzePaste() {
  const text = document.getElementById('rq-paste-input').value;
  const status = document.getElementById('rq-paste-status');
  if (text.trim().length < 30) {
    status.className = 'req-status err'; status.textContent = '내용이 너무 짧습니다. 모집분야와 자격요건을 포함해 붙여넣어주세요.';
    return;
  }
  status.className = 'req-status'; status.textContent = '🤖 분석 중… (2단: 정제 → 구조화, 약 15~20초)';
  try {
    const r = await api('/api/ai/analyze-requirements', { method: 'POST', body: { text } });
    resumeState.req = r.bundle;
    resumeState.reqMeta = { req_source: 'paste', req_posting_id: null, req_url: null, req_text: null };
    renderReqPreview();
    const co = document.getElementById('re-company');
    if (co && !co.value.trim() && r.bundle.company) co.value = r.bundle.company;
    status.className = 'req-status ok'; status.textContent = '✓ 분석 완료! 아래 미리보기를 확인·수정해주세요.';
  } catch (e) {
    status.className = 'req-status err';
    status.textContent = isAiBusyError(e) ? ('⚠ ' + (e.serverMsg || e.message)) : e.message;
  }
}

// 요구사항 이벤트 바인딩 (bindResumeEvents 에서 1회)
let reqEventsBound = false;
function bindReqEvents() {
  if (reqEventsBound) return;
  reqEventsBound = true;
  on('req-toggle', 'click', () => toggleReqSection());
  document.querySelectorAll('.req-tab').forEach((t) =>
    t.addEventListener('click', () => switchReqTab(t.dataset.reqTab)));
  on('rq-db-search', 'click', searchDbPostings);
  on('rq-db-query', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchDbPostings(); } });
  on('rq-url-fetch', 'click', fetchUrlRequirements);
  on('rq-url-input', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchUrlRequirements(); } });
  on('rq-paste-analyze', 'click', analyzePaste);
  on('req-clear', 'click', clearReq);
}

// 자소서 5개 항목 정의 (표준)
const COVER_ITEMS = [
  { key: 'motivation', label: '① 지원동기' },
  { key: 'growth', label: '② 성장과정' },
  { key: 'strength', label: '③ 성격의 장단점' },
  { key: 'career', label: '④ 직무경험' },
  { key: 'vision', label: '⑤ 입사 후 포부' },
];

// 프로필 폼의 항목별 강조 포인트 입력칸 id 매핑 (AI 작성 요구사항)
const EMPHASIS_KEYS = ['motivation', 'growth', 'strength', 'career', 'vision'];

async function renderResumeView() {
  try {
    const [profiles, jobs] = await Promise.all([
      api('/api/profiles'),
      api('/api/target-jobs'),
    ]);
    resumeState.profiles = profiles;
    resumeState.targetJobs = jobs;
    fillTargetJobOptions([]);
    renderProfileList();
    bindResumeEvents();
    showEditorEmpty();
    setStep(profiles.length ? '프로필 선택' : '새 프로필 만들기');
  } catch (e) {
    console.error('[resume]', e);
    document.getElementById('r-profile-list').innerHTML =
      '<div class="resume-empty">이력서 데이터를 불러오지 못했습니다.</div>';
  }
}

// 타겟 직무 <select> 옵션 채우기
function fillTargetJobOptions(except) {
  const sel = document.getElementById('re-target-job');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">타겟 직무 선택</option>' +
    resumeState.targetJobs.map((j) => `<option value="${escapeAttr(j.name)}">${escapeHTML(j.name)} (${j.c})</option>`).join('');
  if (cur) sel.value = cur;
}

// 프로필 목록 렌더 + 각 버튼에 개별 이벤트 부착 (위임 방식의 미묘한 버그 회피)
function renderProfileList() {
  const el = document.getElementById('r-profile-list');
  if (!resumeState.profiles.length) {
    el.innerHTML = '<div class="resume-empty">아직 프로필이 없어요. "+ 새 프로필"을 눌러 시작하세요.</div>';
    return;
  }
  el.innerHTML = resumeState.profiles.map((p) => `
    <div class="resume-profile-item ${p.id === resumeState.currentProfileId ? 'active' : ''}" data-act="select" data-id="${p.id}">
      <div class="rp-main">
        <span class="rp-name">${escapeHTML(p.name)}</span>
        <span class="rp-count">자소서 ${p.letter_count || 0}개</span>
      </div>
      <div class="rp-actions">
        <button class="btn btn-sm btn-ghost" data-act="edit-profile" data-id="${p.id}">편집</button>
        <button class="btn btn-sm btn-danger" data-act="del-profile" data-id="${p.id}">삭제</button>
      </div>
    </div>`).join('');
  // 렌더링 후 각 요소에 개별 리스너 부착 (이벤트 위임 버그 원천 제거)
  el.querySelectorAll('[data-act]').forEach((node) => {
    node.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const act = node.dataset.act;
      const id = Number(node.dataset.id);
      if (act === 'select') selectProfile(id);
      else if (act === 'edit-profile') editProfile(id);
      else if (act === 'del-profile') deleteProfile(id);
    });
  });
}

// 프로필 폼 토글 (신규/편집)
function showProfileForm(profile) {
  resumeState.editingProfileId = profile ? profile.id : null;
  document.getElementById('r-profile-form').classList.remove('hidden');
  document.getElementById('rf-name').value = profile?.name || '';
  document.getElementById('rf-experience').value = profile?.experience || '';
  document.getElementById('rf-skills').value = profile?.skills || '';
  document.getElementById('rf-portfolio').value = profile?.portfolio || '';
  // 항목별 강조 포인트 채우기 (emphasis JSON → 각 칸)
  let emphasis = {};
  if (profile?.emphasis) {
    try { emphasis = JSON.parse(profile.emphasis); } catch { emphasis = {}; }
  }
  EMPHASIS_KEYS.forEach((k) => {
    document.getElementById(`rf-em-${k}`).value = emphasis[k] || '';
  });
  document.getElementById('rf-name').focus();
}
function hideProfileForm() {
  resumeState.editingProfileId = null;
  document.getElementById('r-profile-form').classList.add('hidden');
}

// 프로필 선택 → 하이라이트 + 자소서 목록/에디터 표시
// 자소서가 있으면 최근 것을 열고, 없으면 새 자소서를 만들어 에디터를 바로 열어
// 프로필 선택 → 리스트 모드 진입 (저장된 자소서 목록 + "AI로 초안 생성" 카드)
async function selectProfile(id) {
  resumeState.currentProfileId = id;
  renderProfileList();           // 활성 하이라이트 먼저 반영
  await showListView(id);        // 리스트 모드로 진입 (id 명시 전달 → 경합 안전)
  refreshProfilesState();        // 개수 갱신은 뒤로 (fire-and-forget)
}

// 프로필 편집
async function editProfile(id) {
  const p = await api(`/api/profiles/${id}`);
  showProfileForm(p);
}

// 프로필 삭제
async function deleteProfile(id) {
  if (!confirm('이 프로필과 연결된 자소서가 모두 삭제됩니다. 계속할까요?')) return;
  await api(`/api/profiles/${id}`, { method: 'DELETE' });
  if (resumeState.currentProfileId === id) {
    resumeState.currentProfileId = null;
    showEditorEmpty();
  }
  resumeState.profiles = await api('/api/profiles');
  renderProfileList();
}

// 자소서 목록 렌더 (리스트 모드에서 저장된 자소서 표시)
function renderLetters(letters) {
  const el = document.getElementById('r-letters');
  if (!letters.length) {
    // 저장된 자소서 없음 → 목록 영역 비움 (아래 "AI로 초안 생성" 카드가 안내 역할)
    el.innerHTML = '';
    return;
  }
  el.innerHTML = '<div class="resume-letters-title">저장된 자소서</div>' +
    letters.map((c) => {
      const sub = [c.company, c.target_job].filter(Boolean).join(' · ') || '직무 미지정';
      return `
      <div class="resume-letter-item ${c.id === resumeState.currentLetterId ? 'active' : ''}" data-id="${c.id}">
        <div class="rl-main" data-id="${c.id}">
          <span class="rl-title">${escapeHTML(c.title)}</span>
          <span class="rl-job">${escapeHTML(sub)}</span>
        </div>
        <button class="rl-del" data-act="del-letter" data-id="${c.id}" title="삭제" aria-label="자소서 삭제">✕</button>
      </div>`;
    }).join('');
}

// 현재 단계 표시 (헤더 오른쪽 chip) — 초보자 가이드용
function setStep(msg) {
  const el = document.getElementById('re-step');
  if (el) el.textContent = msg || '';
}

// 에디터: 항목 textarea 생성
function renderEditorItems(letter) {
  const el = document.getElementById('re-items');
  el.innerHTML = COVER_ITEMS.map((it) => `
    <div class="resume-item">
      <label class="field-label">${it.label}</label>
      <textarea class="textarea" id="ri-${it.key}" rows="6" placeholder="AI 생성 또는 직접 작성">${escapeHTML(letter?.[it.key] || '')}</textarea>
    </div>`).join('');
}

function readEditorItems() {
  const o = {};
  COVER_ITEMS.forEach((it) => { o[it.key] = document.getElementById(`ri-${it.key}`).value; });
  return o;
}

// 모드 숨김 헬퍼 (세 상태: empty / list-view / editor)
function hideAllResumeViews() {
  document.getElementById('r-editor-empty').classList.add('hidden');
  document.getElementById('r-list-view').classList.add('hidden');
  document.getElementById('r-editor').classList.add('hidden');
}

// 상태 0: 프로필 미선택
function showEditorEmpty() {
  hideAllResumeViews();
  document.getElementById('r-editor-empty').classList.remove('hidden');
  setStep('');
}

// 상태 1: 리스트 모드 (저장된 자소서 목록 + "AI로 초안 생성" 카드)
async function showListView(profileId) {
  hideAllResumeViews();
  document.getElementById('r-list-view').classList.remove('hidden');
  resumeState.currentLetterId = null;
  setStep('자소서를 선택하거나 새로 작성');
  // 저장된 자소서 목록 갱신 (profileId 인자 우선, 없으면 currentProfileId 폴백)
  const pid = profileId ?? resumeState.currentProfileId;
  if (pid) {
    const data = await api(`/api/profiles/${pid}`);
    // 경합 가드: await 사이에 다른 프로필이 선택됐다면 이 응답은 버림 (자소서 섞임 방지)
    if (resumeState.currentProfileId !== pid) return;
    renderLetters(data.coverLetters || []);
  }
}

// 상태 2: 에디터 모드 (상단 항상 "← 목록으로" 버튼)
function openEditor(letter, isNew = false) {
  hideAllResumeViews();
  document.getElementById('r-editor').classList.remove('hidden');
  resumeState.currentLetterId = letter.id;
  document.getElementById('re-title').value = letter.title || '';
  document.getElementById('re-target-job').value = letter.target_job || '';
  document.getElementById('re-company').value = letter.company || '';
  document.getElementById('re-bar-title').textContent = letter.title || '새 자소서';
  renderEditorItems(letter);
  // ★ Step 9: 저장된 요구사항 복원 (다른 자소서 열 때 잔존 방지를 위해 항상 초기화 후 복원)
  resumeState.req = null;
  resumeState.reqMeta = null;
  if (letter.req_json) {
    try {
      resumeState.req = JSON.parse(letter.req_json);
      resumeState.reqMeta = {
        req_source: letter.req_source || null,
        req_posting_id: letter.req_posting_id || null,
        req_url: letter.req_url || null,
        req_text: letter.req_text || null,
      };
    } catch { /* 손상된 JSON은 무시 */ }
  }
  renderReqPreview();
  updateHint();   // 회사명 입력 여부에 따라 힌트 갱신
  setStatus('');
  setStep(isNew ? '직무 선택 → AI 초안 생성' : '수정 중');
  refreshLetterListActive();
}

// 회사명 입력 여부에 따라 AI 생성 힌트 갱신
function updateHint() {
  const el = document.getElementById('re-hint');
  if (!el) return;
  const company = document.getElementById('re-company').value.trim();
  const hasReq = !!resumeState.req;
  if (hasReq) {
    el.innerHTML = `📋 <strong>채용공고 요구사항이 설정되었습니다.</strong> AI가 그 공고의 주요업무·자격요건·우대사항에 내 스택·경험을 직접 매핑해 작성합니다.${company ? ` (${escapeHTML(company)}의 인재상도 함께 반영)` : ''} <strong>"🤖 AI로 초안 생성"</strong>을 누르세요.`;
    return;
  }
  el.innerHTML = company
    ? `🏢 <strong>${escapeHTML(company)}</strong>의 <strong>핵심가치·비전·인재상·지향점</strong>을 먼저 파악해 반영합니다. 이를 토대로 자소서 5개 항목(특히 [지원동기]·[입사 후 포부])을 그 회사가 바라는 방향에 맞춰 작성합니다. 직무를 선택하고 <strong>"🤖 AI로 초안 생성"</strong>을 누르세요.<br>💡 <strong>더 정확한 자소서</strong>: 아래 <strong>📋 채용공고 요구사항</strong>에 실제 공고를 가져오면 그 공고가 원하는 역량에 맞춰 작성됩니다.`
    : `💡 <strong>회사명을 넣지 않았습니다.</strong> 회사명을 입력하면 그 기업의 <strong>핵심가치·비전·인재상·지향점</strong>을 파악해 맞춤형 자소서를 작성해 드려요. 직무를 선택하고 <strong>"🤖 AI로 초안 생성"</strong>을 누르면 직무 기준으로만 작성됩니다.<br>💡 <strong>더 정확한 자소서</strong>: 아래 <strong>📋 채용공고 요구사항</strong>에 실제 공고를 가져오세요 (DB 검색 / URL / 붙여넣기).`;
}

// AI 생성 결과 안내 — 회사명에 따라 명시적 토대 설명
function generationResultMessage() {
  const company = document.getElementById('re-company').value.trim();
  return company
    ? `✅ <strong>${escapeHTML(company)}</strong>의 핵심가치·비전·인재상·지향점을 파악해 반영하고, 이를 토대로 자소서 초안을 만들었습니다! 특히 [지원동기]와 [입사 후 포부]에 그 회사가 추구하는 가치가 녹아 있습니다. 내용을 확인·수정한 뒤 💾 저장을 누르세요.`
    : `✅ 자소서 초안이 생성되었습니다! <strong>(회사명을 넣지 않아 직무 기준으로만 작성했습니다.)</strong> 회사의 핵심가치·인재상까지 반영한 맞춤 자소서를 원하시면 회사명 입력 후 다시 생성해 보세요. 내용을 확인·수정한 뒤 💾 저장을 누르세요.`;
}

async function refreshLetterListActive() {
  const pid = resumeState.currentProfileId;
  if (!pid) return;
  const data = await api(`/api/profiles/${pid}`);
  // 경합 가드: await 사이에 다른 프로필이 선택됐다면 이 응답은 버림
  if (resumeState.currentProfileId !== pid) return;
  renderLetters(data.coverLetters || []);
}

// 자소서 수가 변하면 좌측 프로필 목록의 letter_count도 최신화 (정합성)
async function refreshProfilesState() {
  resumeState.profiles = await api('/api/profiles');
  renderProfileList();
}

// 자소서 삭제 (리스트 모드에서 각 항목의 ✕ 버튼) — 삭제 후 리스트와 프로필 개수 갱신
async function deleteLetter(id) {
  if (!confirm('이 자소서를 삭제할까요?')) return;
  try {
    await api(`/api/cover-letters/${id}`, { method: 'DELETE' });
    if (resumeState.currentLetterId === id) resumeState.currentLetterId = null;
    await refreshLetterListActive();   // 현재 프로필의 자소서 목록 갱신
    await refreshProfilesState();       // 좌측 프로필 자소서 개수 갱신
    setStep('자소서를 선택하거나 새로 작성');
    showListViewToast('🗑 자소서가 삭제되었습니다.');
  } catch (e) { setStatus('삭제 실패: ' + e.message, true); }
}

// 리스트 모드에서 잠깐 떠 있는 안내 메시지 (status 영역 재활용)
function showListViewToast(msg) {
  setStatus(msg, false);
  if (showListViewToast._t) clearTimeout(showListViewToast._t);
  showListViewToast._t = setTimeout(() => {
    // 다른 진행 중 안내가 없을 때만 자동으로 지움
    const el = document.getElementById('re-status');
    if (el && el.textContent === msg) setStatus('');
  }, 3500);
}

function setStatus(msg, isError) {
  const el = document.getElementById('re-status');
  el.textContent = msg || '';
  el.className = 'resume-status' + (isError ? ' err' : '');
}

function setLoading(on, msg) {
  setStatus(on ? (msg || '처리 중... ⏳') : '', false);
  // 명시적 ID로 안전하게 비활성화 (DOM 구조 의존 회피)
  ['re-generate', 're-regenerate', 're-save', 're-back', 're-delete'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.disabled = on;
  });
}

// 이벤트 바인딩 (중복 바인딩 방지)
let resumeEventsBound = false;
function bindResumeEvents() {
  if (resumeEventsBound) return;
  resumeEventsBound = true;
  const root = document.querySelector('[data-view="resume"]');
  bindReqEvents();   // ★ Step 9: 요구사항 소스 3탭

  // 새 프로필
  on('r-new-profile', 'click', () => { hideProfileForm(); showProfileForm(null); });
  on('rf-cancel', 'click', hideProfileForm);
  on('rf-save', 'click', async () => {
    // 항목별 강조 포인트 수집 → 빈 칸 제외한 객체 (서버가 JSON 문자열로 정규화)
    const emphasis = {};
    EMPHASIS_KEYS.forEach((k) => {
      const v = document.getElementById(`rf-em-${k}`).value.trim();
      if (v) emphasis[k] = v;
    });
    const body = {
      name: document.getElementById('rf-name').value.trim(),
      experience: document.getElementById('rf-experience').value,
      skills: document.getElementById('rf-skills').value,
      portfolio: document.getElementById('rf-portfolio').value,
      emphasis,   // 빈 객체여도 서버에서 null 처리
    };
    if (!body.name) return setStatus('프로필명을 입력하세요.', true);
    try {
      let savedId;
      if (resumeState.editingProfileId) {
        await api(`/api/profiles/${resumeState.editingProfileId}`, { method: 'PUT', body });
        savedId = resumeState.editingProfileId;
      } else {
        const created = await api('/api/profiles', { method: 'POST', body });
        savedId = created.id;
      }
      hideProfileForm();
      resumeState.profiles = await api('/api/profiles');
      renderProfileList();
      // 저장/수정 후 해당 프로필을 자동 선택 → 자소서 에디터로 진입
      if (savedId) await selectProfile(savedId);
    } catch (e) { setStatus('저장 실패: ' + e.message, true); }
  });

  // 프로필 목록의 선택/편집/삭제는 renderProfileList() 에서 각 요소에 개별 부착함
  // (위임 방식 제거 → closest 매칭 버그 원천 차단)

  // 새 자소서 작성 (리스트 모드의 "AI로 초안 생성" 카드 클릭)
  on('re-new-letter-card', 'click', async () => {
    if (!resumeState.currentProfileId) return;
    const c = await api('/api/cover-letters', {
      method: 'POST',
      body: { profile_id: resumeState.currentProfileId, title: '새 자소서', target_job: '' },
    });
    clearReq();                        // ★ Step 9: 새 자소서는 요구사항 초기화
    openEditor(c, true);              // 에디터 모드로 진입 (초안 가이드 강조)
    await refreshProfilesState();      // 좌측 프로필 개수 갱신
  });

  // 목록으로 가기 — 에디터 → 리스트 모드로 복귀 (수정본 미저장)
  on('re-back', 'click', async () => {
    if (!resumeState.currentProfileId) return;
    await showListView();
    setStatus('💾 수정 내용은 저장하지 않았어요. 자소서를 다시 누르면 이어서 편집할 수 있어요.', false);
  });

  // 회사명/직무 입력 시 AI 생성 힌트 실시간 갱신
  const companyEl = document.getElementById('re-company');
  if (companyEl) companyEl.addEventListener('input', updateHint);

  // 자소서 목록 — 선택(편집) 또는 삭제 (이벤트 위임)
  document.getElementById('r-letters').addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-act="del-letter"]');
    if (delBtn) {                        // 삭제 버튼
      e.stopPropagation();
      await deleteLetter(Number(delBtn.dataset.id));
      return;
    }
    const item = e.target.closest('.rl-main');   // 본문 영역 → 에디터 진입
    if (!item) return;
    const c = await api(`/api/cover-letters/${Number(item.dataset.id)}`);
    openEditor(c);
  });

  // AI 초안 생성
  on('re-generate', 'click', async () => {
    if (!resumeState.currentLetterId) return setStatus('자소서를 먼저 선택하세요.', true);
    const job = document.getElementById('re-target-job').value;
    if (!job) {
      setStatus('⚠ 먼저 위에서 타겟 직무를 선택하세요. (예: 소프트웨어)', true);
      document.getElementById('re-target-job').focus();
      return;
    }
    setLoading(true, '🤖 AI가 자소서를 작성 중입니다... (최대 1분)');
    try {
      await saveCurrentTitleJob();
      const c = await api(`/api/cover-letters/${resumeState.currentLetterId}/generate`, { method: 'POST' });
      openEditor(c);
      setStatus(generationResultMessage(), false);
      setStep('내용 확인·수정 후 💾 저장');
    } catch (e) {
      // 과부하(503 AI_BUSY) — 일시 장애 안내
      if (isAiBusyError(e)) return setStatus('⚠ ' + (e.serverMsg || e.message), true);
      setStatus('생성 실패: ' + e.message + ' (재시도 가능)', true);
    }
    finally { setLoading(false); }
  });

  // 직무 변경 재생성 ★
  on('re-regenerate', 'click', async () => {
    if (!resumeState.currentLetterId) return setStatus('자소서를 먼저 선택하세요.', true);
    const newJob = document.getElementById('re-target-job').value;
    if (!newJob) return setStatus('재생성할 타겟 직무를 선택하세요.', true);
    setLoading(true, '🔄 AI가 새 직무에 맞춰 재작성 중입니다...');
    try {
      const c = await api(`/api/cover-letters/${resumeState.currentLetterId}/regenerate`, {
        method: 'POST', body: { target_job: newJob },
      });
      openEditor(c);
      setStatus(generationResultMessage(), false);
      setStep('내용 확인·수정 후 💾 저장');
    } catch (e) {
      if (isAiBusyError(e)) return setStatus('⚠ ' + (e.serverMsg || e.message), true);
      setStatus('재생성 실패: ' + e.message + ' (재시도 가능)', true);
    }
    finally { setLoading(false); }
  });

  // 저장 — 초안/수정본 저장 후 리스트 모드로 복귀
  on('re-save', 'click', async () => {
    if (!resumeState.currentLetterId) return;
    try {
      const body = { ...readEditorItems() };
      const saved = await saveCurrentTitleJob(body);
      await refreshProfilesState();   // 자소서 수/제목 변경 반영
      await showListView();            // 리스트 모드로 복귀 (저장된 자소서 목록에 표시)
      setStatus(`💾 저장 완료! "${saved.title}" 자소서가 목록에 있어요.`, false);
    } catch (e) { setStatus('저장 실패: ' + e.message, true); }
  });

  // 삭제 — 삭제 후 리스트 모드로 복귀
  on('re-delete', 'click', async () => {
    if (!resumeState.currentLetterId) return;
    if (!confirm('이 자소서를 삭제할까요?')) return;
    await api(`/api/cover-letters/${resumeState.currentLetterId}`, { method: 'DELETE' });
    await refreshProfilesState();      // 좌측 프로필 개수 갱신
    await showListView();              // 리스트 모드로 복귀
    setStatus('🗑 자소서가 삭제되었습니다.', false);
  });
}

// 제목/직무 저장 헬퍼 (기존 항목과 함께 PUT)
// ★ Step 9: 요구사항 번들(req)도 함께 저장 — 미리보기 카드의 수정 내용을 반영
async function saveCurrentTitleJob(extra) {
  if (!resumeState.currentLetterId) return;
  collectReqFromPreview();   // 미리보기 카드의 편집 내용 → state
  const req = resumeState.req;
  const meta = resumeState.reqMeta || {};
  const body = {
    title: document.getElementById('re-title').value.trim() || '제목 없음',
    target_job: document.getElementById('re-target-job').value,
    company: document.getElementById('re-company').value.trim(),
    // 요구사항 저장 (없으면 전부 null → 서버 UPDATE가 null 처리… 는 하지 않으므로 명시적 전달)
    req_source: req ? (meta.req_source || req.meta?.source || 'company') : null,
    req_posting_id: req ? (meta.req_posting_id || null) : null,
    req_url: req ? (meta.req_url || null) : null,
    req_text: req ? (meta.req_text || null) : null,
    req_json: req ? JSON.stringify(req) : null,
    ...(extra || {}),
  };
  return api(`/api/cover-letters/${resumeState.currentLetterId}`, { method: 'PUT', body });
}

/* ---------------- 시작 ---------------- */
async function main() {
  applyChartDefaults();
  // 내비게이션 바인딩 (요소 없으면 스킵)
  document.querySelectorAll('.nav-tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)));
  // 이벤트 바인딩 실패가 데이터 로드를 막지 않도록 분리
  try { bindAuthEvents(); } catch (e) { console.error('[bindAuth]', e); }
  try { bindDashboardEvents(); } catch (e) { console.error('[bindDashboard]', e); }
  try { bindCustomEvents(); } catch (e) { console.error('[bindCustom]', e); }
  try { await restoreAuth(); } catch (e) { console.error('[restoreAuth]', e); }
  try { await fillFilterOptions(); } catch (e) { console.error('[fillFilters]', e); }
  await Promise.allSettled([refreshAll(), renderPostings()]);
}

document.addEventListener('DOMContentLoaded', main);
