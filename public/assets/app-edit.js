/**
 * Field-by-field editor for DRE/FC entries. Opens an inline panel below
 * the period picker with a table of 12 monthly inputs per category,
 * grouped by section (Receita / Custos / Despesas Op / Entradas FC / etc).
 *
 * Autosave strategy:
 *   - onInput debounced 600 ms sends PUT /api/periods/:id/entries with
 *     the FULL state (all categories as the server expects replace-all
 *     semantics).
 *   - Status indicator: "Salvando..." → "Salvo há Ns" (updates every 10s)
 *     → "Erro: <msg>" on failure.
 *   - After every successful save, ask the period-loader to refresh the
 *     dashboard so numbers stay in sync.
 *
 * Each input uses the same BRL mask as the v1 SPA (1.234,56). Non-money
 * fields (pedidos in FC) use a plain integer input instead.
 */
(function () {
  'use strict';

  const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  // Section structure for each period type, mirroring the v1 dashboard
  // grouping so the edit form feels continuous with the read view.
  const DRE_SECTIONS = [
    { title: 'RECEITA', categories: [
      { key: 'receita', label: 'Receita de Vendas', kind: 'money' },
      { key: 'deducoes', label: 'Deduções e Impostos', kind: 'money' },
    ] },
    { title: 'CUSTOS DIRETOS', categories: [
      { key: 'cmv', label: 'CMV / Logística', kind: 'money' },
      { key: 'outrosCustos', label: 'Outros Custos Diretos', kind: 'money' },
      { key: 'equipamentos', label: 'Equipamentos', kind: 'money' },
      { key: 'provisao', label: 'Provisão Manutenção', kind: 'money' },
    ] },
    { title: 'DESPESAS OPERACIONAIS', categories: [
      { key: 'pessoal', label: 'Pessoal (Salários CLT)', kind: 'money' },
      { key: 'beneficios', label: 'Benefícios', kind: 'money' },
      { key: 'inss', label: 'INSS / FGTS', kind: 'money' },
      { key: 'proLabore', label: 'Pró-Labore', kind: 'money' },
      { key: 'ferias', label: 'Férias / 13°', kind: 'money' },
      { key: 'aluguel', label: 'Aluguel', kind: 'money' },
      { key: 'marketing', label: 'Marketing', kind: 'money' },
      { key: 'ti', label: 'TI / Tecnologia', kind: 'money' },
      { key: 'diversas', label: 'Despesas Diversas', kind: 'money' },
      { key: 'manutPredial', label: 'Manutenção Predial', kind: 'money' },
      { key: 'exames', label: 'Exames / Saúde', kind: 'money' },
      { key: 'despFin', label: 'Despesas Financeiras', kind: 'money' },
    ] },
  ];

  const FC_SECTIONS = [
    { title: 'ENTRADAS', categories: [
      { key: 'pedidos', label: 'Nº de Pedidos', kind: 'int' },
      { key: 'ticketMedio', label: 'Ticket Médio', kind: 'money' },
      { key: 'receita', label: 'Receita de Vendas', kind: 'money' },
    ] },
    { title: 'SAÍDAS', categories: [
      { key: 'cmv', label: 'CMV / Logística', kind: 'money' },
      { key: 'outrosCustos', label: 'Outros Custos Diretos', kind: 'money' },
      { key: 'equipamentos', label: 'Equipamentos', kind: 'money' },
      { key: 'provisao', label: 'Provisão Manutenção', kind: 'money' },
      { key: 'pessoal', label: 'Pessoal (Salários CLT)', kind: 'money' },
      { key: 'beneficios', label: 'Benefícios', kind: 'money' },
      { key: 'inss', label: 'INSS / FGTS', kind: 'money' },
      { key: 'proLabore', label: 'Pró-Labore', kind: 'money' },
      { key: 'ferias', label: 'Férias / 13°', kind: 'money' },
      { key: 'aluguel', label: 'Aluguel', kind: 'money' },
      { key: 'marketing', label: 'Marketing', kind: 'money' },
      { key: 'ti', label: 'TI / Tecnologia', kind: 'money' },
      { key: 'diversas', label: 'Despesas Diversas', kind: 'money' },
      { key: 'manutPredial', label: 'Manutenção Predial', kind: 'money' },
      { key: 'exames', label: 'Exames / Saúde', kind: 'money' },
      { key: 'despFin', label: 'Despesas Financeiras', kind: 'money' },
    ] },
  ];

  // ---------- BRL mask ----------
  // Reads the mask-formatted value back into a plain number.
  function parseBRL(text) {
    if (text == null) return 0;
    const cleaned = String(text).replace(/\./g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  function formatBRL(n) {
    if (!Number.isFinite(n) || n === 0) return '';
    const abs = Math.abs(n);
    const cents = Math.round(abs * 100);
    const int = Math.floor(cents / 100);
    const dec = String(cents % 100).padStart(2, '0');
    const intStr = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (n < 0 ? '-' : '') + intStr + ',' + dec;
  }

  function bindMoneyMask(input) {
    input.addEventListener('input', () => {
      let digits = input.value.replace(/\D/g, '');
      if (!digits) { input.value = ''; return; }
      digits = digits.replace(/^0+/, '') || '0';
      while (digits.length < 3) digits = '0' + digits;
      const cents = digits.slice(-2);
      let intPart = digits.slice(0, -2);
      intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      input.value = intPart + ',' + cents;
    });
  }

  // ---------- state ----------
  const panelState = {
    DRE: { open: false, periodId: null, entries: {}, finalizado: false, saveTimer: null, lastSavedAt: null },
    FC:  { open: false, periodId: null, entries: {}, finalizado: false, saveTimer: null, lastSavedAt: null },
  };

  // ---------- UI ----------
  function sectionsFor(type) { return type === 'DRE' ? DRE_SECTIONS : FC_SECTIONS; }

  function ensurePanelContainer(type) {
    const tabId = type === 'DRE' ? 'tab-dre' : 'tab-fc';
    const tab = document.getElementById(tabId);
    if (!tab) return null;
    let panel = document.getElementById(type + '-edit-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = type + '-edit-panel';
      panel.style.cssText = 'display:none;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;margin-bottom:1.5rem;box-shadow:var(--shadow-sm);';
      // Insert right after the period bar.
      const bar = document.getElementById(type === 'DRE' ? 'dre-period-bar' : 'fc-period-bar');
      if (bar && bar.nextSibling) tab.insertBefore(panel, bar.nextSibling);
      else tab.appendChild(panel);
    }
    return panel;
  }

  function ensureToggleButton(type) {
    const bar = document.getElementById(type === 'DRE' ? 'dre-period-bar' : 'fc-period-bar');
    if (!bar) return;
    // Append a toggle button to the period bar on each render.
    const btnId = type + '-edit-toggle';
    let btn = document.getElementById(btnId);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = btnId;
    btn.type = 'button';
    btn.textContent = '✎ Editar valores';
    btn.style.cssText = 'padding:0.5rem 1rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text);font-size:0.8rem;font-weight:600;cursor:pointer;font-family:inherit;';
    btn.addEventListener('click', () => togglePanel(type));
    const innerBar = bar.firstChild;
    if (innerBar) innerBar.appendChild(btn);
    return btn;
  }

  async function togglePanel(type) {
    const active = window.bcPeriods?.getActive(type);
    if (!active) {
      alert('Selecione um período antes de editar.');
      return;
    }
    const state = panelState[type];
    state.open = !state.open;
    const panel = ensurePanelContainer(type);
    if (!panel) return;
    if (state.open) {
      panel.style.display = 'block';
      await loadPanelData(type);
      renderPanel(type);
      // Collapse the dashboard while editing to reduce cognitive load.
      const dashboard = document.getElementById(type === 'DRE' ? 'dre-dashboard' : 'fc-dashboard');
      if (dashboard) dashboard.style.display = 'none';
    } else {
      panel.style.display = 'none';
      // Reopen dashboard with latest data.
      if (window.bcPeriodLoader) window.bcPeriodLoader.loadAndRender(type, active.id);
    }
  }

  async function loadPanelData(type) {
    const active = window.bcPeriods?.getActive(type);
    if (!active || !window.bcPeriods) return;
    const state = panelState[type];
    try {
      const resp = await window.bcPeriods.api('GET', '/api/periods/' + encodeURIComponent(active.id) + '/entries');
      state.periodId = active.id;
      state.entries = resp.entries || {};
      state.finalizado = active.status === 'FINALIZED';
    } catch (err) {
      alert('Erro ao carregar entradas: ' + err.message);
    }
  }

  function renderPanel(type) {
    const panel = ensurePanelContainer(type);
    if (!panel) return;
    const state = panelState[type];
    panel.innerHTML = '';

    // Header with title + status indicator + close button.
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:1rem;flex-wrap:wrap;';

    const title = document.createElement('h3');
    title.style.cssText = 'font-size:0.95rem;font-weight:700;margin:0;';
    title.textContent = 'Editar valores — ' + type;
    header.appendChild(title);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:0.5rem;align-items:center;';
    const status = document.createElement('span');
    status.id = type + '-edit-status';
    status.style.cssText = 'font-size:0.78rem;color:var(--text-muted);';
    right.appendChild(status);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Fechar';
    closeBtn.style.cssText = 'padding:0.4rem 0.9rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);cursor:pointer;font-size:0.78rem;font-family:inherit;';
    closeBtn.addEventListener('click', () => togglePanel(type));
    right.appendChild(closeBtn);
    header.appendChild(right);
    panel.appendChild(header);

    if (state.finalizado) {
      const note = document.createElement('div');
      note.style.cssText = 'padding:0.7rem;background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:var(--radius-sm);font-size:0.82rem;margin-bottom:1rem;';
      note.textContent = 'Este período está finalizado — valores são apenas leitura.';
      panel.appendChild(note);
    }

    const tableWrap = document.createElement('div');
    tableWrap.style.cssText = 'overflow-x:auto;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.78rem;';

    // Thead
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    const catTh = document.createElement('th');
    catTh.textContent = 'Categoria';
    catTh.style.cssText = 'position:sticky;left:0;background:var(--bg);padding:0.5rem 0.75rem;text-align:left;font-size:0.7rem;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border);min-width:200px;';
    hrow.appendChild(catTh);
    MONTHS.forEach((m) => {
      const th = document.createElement('th');
      th.textContent = m;
      th.style.cssText = 'padding:0.5rem 0.4rem;text-align:right;font-size:0.7rem;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border);font-family:"Space Mono",monospace;min-width:90px;';
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    // Tbody
    const tbody = document.createElement('tbody');
    for (const section of sectionsFor(type)) {
      const secRow = document.createElement('tr');
      const secTd = document.createElement('td');
      secTd.colSpan = 13;
      secTd.textContent = section.title;
      secTd.style.cssText = 'background:var(--bg);padding:0.6rem 0.75rem;font-size:0.72rem;font-weight:700;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;';
      secRow.appendChild(secTd);
      tbody.appendChild(secRow);

      for (const cat of section.categories) {
        const tr = document.createElement('tr');
        const tdL = document.createElement('td');
        tdL.textContent = cat.label;
        tdL.style.cssText = 'position:sticky;left:0;background:var(--bg-card);padding:0.45rem 0.75rem;border-bottom:1px solid var(--border-light);font-weight:500;';
        tr.appendChild(tdL);
        const current = state.entries[cat.key] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let m = 0; m < 12; m++) {
          const td = document.createElement('td');
          td.style.cssText = 'padding:0.25rem;border-bottom:1px solid var(--border-light);';
          const input = document.createElement('input');
          input.type = 'text';
          input.dataset.category = cat.key;
          input.dataset.month = String(m);
          input.dataset.kind = cat.kind;
          input.value = cat.kind === 'money'
            ? formatBRL(current[m] || 0)
            : (current[m] ? String(Math.round(current[m])) : '');
          input.placeholder = '0';
          input.disabled = state.finalizado;
          input.style.cssText = 'width:100%;padding:0.35rem 0.5rem;border:1px solid var(--border);border-radius:6px;font-family:"Space Mono",monospace;font-size:0.8rem;background:var(--bg-input);outline:none;text-align:right;';
          if (cat.kind === 'money') bindMoneyMask(input);
          if (cat.kind === 'int') {
            input.addEventListener('input', () => {
              input.value = input.value.replace(/\D/g, '');
            });
          }
          input.addEventListener('input', () => scheduleSave(type));
          input.addEventListener('focus', () => input.select());
          td.appendChild(input);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);
    updateStatus(type, 'Carregado');
  }

  function updateStatus(type, text, isError) {
    const el = document.getElementById(type + '-edit-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? 'var(--red)' : 'var(--text-muted)';
  }

  function scheduleSave(type) {
    const state = panelState[type];
    if (state.finalizado) return;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    updateStatus(type, 'Alterações pendentes...');
    state.saveTimer = setTimeout(() => doSave(type), 600);
  }

  async function doSave(type) {
    const state = panelState[type];
    if (!state.periodId) return;
    // Collect current input values.
    const panel = document.getElementById(type + '-edit-panel');
    if (!panel) return;
    const inputs = panel.querySelectorAll('input[data-category]');
    const grouped = {};
    inputs.forEach((inp) => {
      const cat = inp.dataset.category;
      const month = parseInt(inp.dataset.month, 10);
      const kind = inp.dataset.kind;
      if (!grouped[cat]) grouped[cat] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      if (kind === 'money') grouped[cat][month] = parseBRL(inp.value);
      else grouped[cat][month] = inp.value ? parseInt(inp.value, 10) || 0 : 0;
    });
    // Only send non-empty categories (any month > 0). Saves DB space
    // and matches the "omit empty" behavior of the server upsert.
    const entries = Object.entries(grouped)
      .filter(([, arr]) => arr.some((v) => v !== 0))
      .map(([category, monthly]) => ({ category, monthly }));
    updateStatus(type, 'Salvando...');
    try {
      await window.bcPeriods.api(
        'PUT',
        '/api/periods/' + encodeURIComponent(state.periodId) + '/entries',
        { entries },
      );
      state.entries = grouped;
      state.lastSavedAt = Date.now();
      updateStatus(type, 'Salvo há poucos segundos');
    } catch (err) {
      updateStatus(type, 'Erro: ' + err.message, true);
    }
  }

  // Periodically refresh "salvo há Ns" text so users know autosave is alive.
  setInterval(() => {
    ['DRE', 'FC'].forEach((type) => {
      const s = panelState[type];
      if (!s.lastSavedAt) return;
      const secs = Math.floor((Date.now() - s.lastSavedAt) / 1000);
      const el = document.getElementById(type + '-edit-status');
      if (!el || el.textContent.startsWith('Erro') || el.textContent.startsWith('Salvando')) return;
      const txt = secs < 5
        ? 'Salvo há poucos segundos'
        : secs < 60 ? 'Salvo há ' + secs + 's' : 'Salvo há ' + Math.floor(secs / 60) + ' min';
      el.textContent = txt;
    });
  }, 10000);

  // Install toggle buttons whenever the period picker re-renders.
  window.addEventListener('bc:period-changed', () => {
    ensureToggleButton('DRE');
    ensureToggleButton('FC');
  });

  // Initial pass.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => { ensureToggleButton('DRE'); ensureToggleButton('FC'); }, 100);
    });
  } else {
    setTimeout(() => { ensureToggleButton('DRE'); ensureToggleButton('FC'); }, 100);
  }
})();
