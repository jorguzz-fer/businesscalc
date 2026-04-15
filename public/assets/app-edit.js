/**
 * Field-by-field editor — Fase 1.5 dynamic categories edition.
 *
 * Replaces the hardcoded category list with one fetched from
 * GET /api/periods/:id/categories. Users can:
 *   - Type values that autosave per-cell via PATCH /api/categories/:id/monthly
 *   - Rename a category by clicking its label (PATCH /api/categories/:id)
 *   - Rename a section header by clicking it (renames every category in
 *     the section under one label group — saved per-category in a
 *     separate "sectionLabel" overlay localStorage; section enum stays
 *     the same on the server because that drives the math)
 *   - Add a new category in any section ("+ Adicionar item")
 *   - Delete any category (lixeira icon)
 */
(function () {
  'use strict';

  const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  // Order of sections per period type. Section enum lives on the server;
  // here we just decide in what order to render them.
  const DRE_SECTION_ORDER = ['RECEITA', 'DEDUCOES', 'CUSTOS_DIRETOS', 'DESPESAS_OP'];
  const FC_SECTION_ORDER = ['ENTRADAS_FC', 'SAIDAS_FC'];

  // Default human-readable section title for each enum. User can override
  // via the editable section header (saved per-period in localStorage so
  // we don't need a server schema change for purely-cosmetic labels).
  const DEFAULT_SECTION_TITLES = {
    RECEITA: 'RECEITA',
    DEDUCOES: 'DEDUÇÕES',
    CUSTOS_DIRETOS: 'CUSTOS DIRETOS',
    DESPESAS_OP: 'DESPESAS OPERACIONAIS',
    ENTRADAS_FC: 'ENTRADAS',
    SAIDAS_FC: 'SAÍDAS',
  };

  function sectionTitleKey(periodId, section) {
    return 'bc-section-title-' + periodId + '-' + section;
  }
  function getSectionTitle(periodId, section) {
    return localStorage.getItem(sectionTitleKey(periodId, section)) || DEFAULT_SECTION_TITLES[section];
  }
  function setSectionTitle(periodId, section, title) {
    if (!title || title === DEFAULT_SECTION_TITLES[section]) {
      localStorage.removeItem(sectionTitleKey(periodId, section));
    } else {
      localStorage.setItem(sectionTitleKey(periodId, section), title);
    }
  }

  // ---------- BRL mask ----------
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
  // windowStart is the index (0-6) of the first month in the visible
  // 6-month window. Default centers the current calendar month so the
  // user doesn't have to navigate on first open for most scenarios.
  const defaultWindowStart = () => {
    const m = new Date().getMonth(); // 0..11
    return Math.max(0, Math.min(6, m - 2));
  };
  const panelState = {
    DRE: { open: false, periodId: null, categories: [], finalizado: false, saveTimers: {}, lastSavedAt: null, windowStart: defaultWindowStart() },
    FC:  { open: false, periodId: null, categories: [], finalizado: false, saveTimers: {}, lastSavedAt: null, windowStart: defaultWindowStart() },
  };
  const WINDOW_SIZE = 6;
  const CURRENT_MONTH = new Date().getMonth(); // for highlight

  // ---------- toggle button on the period bar ----------
  function ensureToggleButton(type) {
    const bar = document.getElementById(type === 'DRE' ? 'dre-period-bar' : 'fc-period-bar');
    if (!bar) return;
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

  function ensurePanelContainer(type) {
    const tabId = type === 'DRE' ? 'tab-dre' : 'tab-fc';
    const tab = document.getElementById(tabId);
    if (!tab) return null;
    let panel = document.getElementById(type + '-edit-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = type + '-edit-panel';
      panel.style.cssText = 'display:none;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;margin-bottom:1.5rem;box-shadow:var(--shadow-sm);';
      const bar = document.getElementById(type === 'DRE' ? 'dre-period-bar' : 'fc-period-bar');
      if (bar && bar.nextSibling) tab.insertBefore(panel, bar.nextSibling);
      else tab.appendChild(panel);
    }
    return panel;
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
      const dashboard = document.getElementById(type === 'DRE' ? 'dre-dashboard' : 'fc-dashboard');
      if (dashboard) dashboard.style.display = 'none';
    } else {
      panel.style.display = 'none';
      if (window.bcPeriodLoader) window.bcPeriodLoader.loadAndRender(type, active.id);
    }
  }

  async function loadPanelData(type) {
    const active = window.bcPeriods?.getActive(type);
    if (!active || !window.bcPeriods) return;
    const state = panelState[type];
    try {
      const resp = await window.bcPeriods.api('GET', '/api/periods/' + encodeURIComponent(active.id) + '/categories');
      state.periodId = active.id;
      state.categories = resp.categories || [];
      state.finalizado = active.status === 'FINALIZED';
    } catch (err) {
      alert('Erro ao carregar categorias: ' + err.message);
    }
  }

  // ---------- header / status ----------
  function renderHeader(type, panel) {
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
    closeBtn.textContent = '✓ Salvar';
    closeBtn.style.cssText = 'padding:0.45rem 1.1rem;border:none;border-radius:var(--radius-sm);background:var(--green);color:#fff;cursor:pointer;font-size:0.82rem;font-weight:700;font-family:inherit;';
    closeBtn.addEventListener('click', () => saveAndClose(type));
    right.appendChild(closeBtn);
    header.appendChild(right);
    panel.appendChild(header);
  }

  // ---------- inline-edit helpers ----------
  function makeEditable(el, opts) {
    // opts: { onSave: (newVal) => Promise<void>, multiline?: false }
    el.style.cursor = 'pointer';
    el.title = 'Clique para editar';
    el.addEventListener('click', () => {
      if (el.dataset.editing === '1') return;
      el.dataset.editing = '1';
      const original = el.textContent || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = original;
      input.style.cssText = 'width:100%;padding:0.2rem 0.4rem;border:1px solid var(--green);border-radius:4px;font-family:inherit;font-size:inherit;font-weight:inherit;color:inherit;background:var(--bg-input);';
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      input.select();
      const finish = async (commit) => {
        if (el.dataset.editing !== '1') return;
        delete el.dataset.editing;
        const next = input.value.trim();
        if (commit && next && next !== original) {
          try { await opts.onSave(next); el.textContent = next; }
          catch (err) { alert('Erro: ' + err.message); el.textContent = original; }
        } else {
          el.textContent = original;
        }
      };
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
    });
  }

  // ---------- main render ----------
  function renderPanel(type) {
    const panel = ensurePanelContainer(type);
    if (!panel) return;
    const state = panelState[type];
    panel.innerHTML = '';
    renderHeader(type, panel);

    if (state.finalizado) {
      const note = document.createElement('div');
      note.style.cssText = 'padding:0.7rem;background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:var(--radius-sm);font-size:0.82rem;margin-bottom:1rem;';
      note.textContent = 'Este período está finalizado — valores são apenas leitura.';
      panel.appendChild(note);
    }

    const sectionOrder = type === 'DRE' ? DRE_SECTION_ORDER : FC_SECTION_ORDER;
    const bySection = {};
    for (const s of sectionOrder) bySection[s] = [];
    for (const c of state.categories) {
      if (bySection[c.section]) bySection[c.section].push(c);
    }
    // Stable sort by sortOrder.
    for (const s of sectionOrder) bySection[s].sort((a, b) => a.sortOrder - b.sortOrder);

    // Month window navigator (only 6 months shown at a time — full 12
    // columns was too wide for laptop screens).
    const start = state.windowStart;
    const end = Math.min(start + WINDOW_SIZE, 12);
    const visibleMonths = MONTHS.slice(start, end);

    const nav = document.createElement('div');
    nav.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;gap:0.5rem;';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.textContent = '‹ Anterior';
    prevBtn.disabled = start === 0;
    prevBtn.style.cssText = 'padding:0.4rem 0.8rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:' + (start === 0 ? 'var(--text-muted)' : 'var(--text)') + ';font-size:0.78rem;font-family:inherit;cursor:' + (start === 0 ? 'not-allowed' : 'pointer') + ';opacity:' + (start === 0 ? '0.5' : '1') + ';';
    prevBtn.addEventListener('click', () => moveWindow(type, -WINDOW_SIZE));

    const rangeLabel = document.createElement('span');
    rangeLabel.style.cssText = 'font-size:0.82rem;font-weight:600;color:var(--text-secondary);font-family:"Space Mono",monospace;';
    rangeLabel.textContent = visibleMonths[0] + ' – ' + visibleMonths[visibleMonths.length - 1];

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.textContent = 'Próximo ›';
    nextBtn.disabled = end >= 12;
    nextBtn.style.cssText = 'padding:0.4rem 0.8rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:' + (end >= 12 ? 'var(--text-muted)' : 'var(--text)') + ';font-size:0.78rem;font-family:inherit;cursor:' + (end >= 12 ? 'not-allowed' : 'pointer') + ';opacity:' + (end >= 12 ? '0.5' : '1') + ';';
    nextBtn.addEventListener('click', () => moveWindow(type, WINDOW_SIZE));

    nav.appendChild(prevBtn);
    nav.appendChild(rangeLabel);
    nav.appendChild(nextBtn);
    panel.appendChild(nav);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.78rem;';

    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    const catTh = document.createElement('th');
    catTh.textContent = 'Categoria';
    catTh.style.cssText = 'position:sticky;left:0;background:var(--bg);padding:0.5rem 0.75rem;text-align:left;font-size:0.7rem;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border);min-width:240px;';
    hrow.appendChild(catTh);
    visibleMonths.forEach((m, idx) => {
      const monthIdx = start + idx;
      const th = document.createElement('th');
      th.textContent = m;
      const isCurrent = monthIdx === CURRENT_MONTH;
      th.style.cssText = 'padding:0.5rem 0.4rem;text-align:right;font-size:0.72rem;font-weight:' + (isCurrent ? '800' : '600') + ';color:' + (isCurrent ? 'var(--green)' : 'var(--text-secondary)') + ';border-bottom:' + (isCurrent ? '2px solid var(--green)' : '1px solid var(--border)') + ';font-family:"Space Mono",monospace;min-width:130px;';
      hrow.appendChild(th);
    });
    // Last column: actions (delete button)
    const actTh = document.createElement('th');
    actTh.textContent = '';
    actTh.style.cssText = 'width:36px;border-bottom:1px solid var(--border);';
    hrow.appendChild(actTh);
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const section of sectionOrder) {
      // Section header row (editable label)
      const secRow = document.createElement('tr');
      const secTd = document.createElement('td');
      secTd.colSpan = WINDOW_SIZE + 2;
      secTd.style.cssText = 'background:var(--bg);padding:0.6rem 0.75rem;font-size:0.72rem;font-weight:700;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;';
      secTd.textContent = getSectionTitle(state.periodId, section);
      if (!state.finalizado) {
        makeEditable(secTd, {
          onSave: async (newVal) => { setSectionTitle(state.periodId, section, newVal); },
        });
      }
      secRow.appendChild(secTd);
      tbody.appendChild(secRow);

      for (const cat of bySection[section]) {
        renderCategoryRow(type, cat, tbody);
      }

      // "+ Adicionar item" row at end of section
      if (!state.finalizado) {
        const addRow = document.createElement('tr');
        const addTd = document.createElement('td');
        addTd.colSpan = WINDOW_SIZE + 2;
        addTd.style.cssText = 'padding:0.4rem 0.75rem;background:var(--bg-card);';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+ Adicionar item em ' + getSectionTitle(state.periodId, section);
        addBtn.style.cssText = 'background:none;border:1px dashed var(--border);color:var(--text-secondary);padding:0.4rem 0.9rem;border-radius:6px;cursor:pointer;font-size:0.78rem;font-family:inherit;';
        addBtn.addEventListener('click', () => addCategory(type, section));
        addTd.appendChild(addBtn);
        addRow.appendChild(addTd);
        tbody.appendChild(addRow);
      }
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    panel.appendChild(wrap);

    // Bottom Salvar bar — same behavior as the top button, positioned so
    // the user doesn't have to scroll back up after filling a long section.
    if (!state.finalizado) {
      const footer = document.createElement('div');
      footer.style.cssText = 'display:flex;justify-content:flex-end;padding-top:1.25rem;margin-top:1rem;border-top:1px solid var(--border-light);gap:0.75rem;align-items:center;';
      const footerStatus = document.createElement('span');
      footerStatus.id = type + '-edit-status-footer';
      footerStatus.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-right:auto;';
      const bottomSave = document.createElement('button');
      bottomSave.type = 'button';
      bottomSave.textContent = '✓ Salvar';
      bottomSave.style.cssText = 'padding:0.6rem 1.4rem;border:none;border-radius:var(--radius-sm);background:var(--green);color:#fff;cursor:pointer;font-size:0.88rem;font-weight:700;font-family:inherit;';
      bottomSave.addEventListener('click', () => saveAndClose(type));
      footer.appendChild(footerStatus);
      footer.appendChild(bottomSave);
      panel.appendChild(footer);
    }

    updateStatus(type, state.finalizado ? 'Read-only' : 'Pronto');
  }

  function renderCategoryRow(type, cat, tbody) {
    const state = panelState[type];
    const tr = document.createElement('tr');
    tr.dataset.categoryId = cat.id;

    const tdL = document.createElement('td');
    tdL.style.cssText = 'position:sticky;left:0;background:var(--bg-card);padding:0.45rem 0.75rem;border-bottom:1px solid var(--border-light);font-weight:500;';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = cat.label;
    labelSpan.style.cssText = 'display:inline-block;padding:0.1rem 0.3rem;border-radius:4px;';
    if (!state.finalizado) {
      makeEditable(labelSpan, {
        onSave: async (newVal) => {
          const updated = await window.bcPeriods.api(
            'PATCH', '/api/categories/' + encodeURIComponent(cat.id),
            { label: newVal },
          );
          cat.label = updated.label;
        },
      });
    }
    tdL.appendChild(labelSpan);
    tr.appendChild(tdL);

    const monthly = Array.isArray(cat.monthly) ? cat.monthly : [0,0,0,0,0,0,0,0,0,0,0,0];
    // Only render the 6 months inside the current window. doSave still
    // collects the full 12-element array by reading from cat.monthly
    // (updated live via onInput below) so months outside the window
    // are preserved across navigations.
    const start = state.windowStart;
    const end = Math.min(start + WINDOW_SIZE, 12);
    for (let m = start; m < end; m++) {
      const td = document.createElement('td');
      const isCurrent = m === CURRENT_MONTH;
      td.style.cssText = 'padding:0.25rem;border-bottom:1px solid var(--border-light);' + (isCurrent ? 'background:rgba(22,163,74,0.04);' : '');
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.month = String(m);
      input.value = cat.kind === 'money'
        ? formatBRL(monthly[m] || 0)
        : (monthly[m] ? String(Math.round(monthly[m])) : '');
      input.placeholder = '0';
      input.disabled = state.finalizado;
      input.style.cssText = 'width:100%;padding:0.35rem 0.4rem;border:' + (isCurrent ? '1.5px solid var(--green)' : '1px solid var(--border)') + ';border-radius:6px;font-family:"Space Mono",monospace;font-size:0.78rem;background:var(--bg-input);outline:none;text-align:right;min-width:0;';
      if (cat.kind === 'money') bindMoneyMask(input);
      else input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });
      // Also mirror the typed value into cat.monthly in real time so
      // window-switching keeps unsaved edits.
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.month, 10);
        cat.monthly = cat.monthly || [0,0,0,0,0,0,0,0,0,0,0,0];
        cat.monthly[idx] = cat.kind === 'money' ? parseBRL(input.value) : (input.value ? parseInt(input.value, 10) || 0 : 0);
        scheduleSave(type, cat.id);
      });
      input.addEventListener('focus', () => input.select());
      td.appendChild(input);
      tr.appendChild(td);
    }

    // Actions cell (delete)
    const actTd = document.createElement('td');
    actTd.style.cssText = 'padding:0.25rem;text-align:center;border-bottom:1px solid var(--border-light);';
    if (!state.finalizado) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.title = 'Apagar este item';
      delBtn.innerHTML = '🗑';
      delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:0.95rem;color:var(--text-muted);padding:0.25rem;border-radius:4px;';
      delBtn.addEventListener('mouseenter', () => { delBtn.style.color = 'var(--red)'; delBtn.style.background = 'var(--red-bg)'; });
      delBtn.addEventListener('mouseleave', () => { delBtn.style.color = 'var(--text-muted)'; delBtn.style.background = 'none'; });
      delBtn.addEventListener('click', async () => {
        if (!confirm('Apagar a categoria "' + cat.label + '"?' + (cat.isSystem ? ' (Item original do template)' : ''))) return;
        try {
          await window.bcPeriods.api('DELETE', '/api/categories/' + encodeURIComponent(cat.id));
          await loadPanelData(type);
          renderPanel(type);
        } catch (err) { alert('Erro: ' + err.message); }
      });
      actTd.appendChild(delBtn);
    }
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }

  async function addCategory(type, section) {
    const label = prompt('Nome do novo item:');
    if (!label) return;
    try {
      const cat = await window.bcPeriods.api(
        'POST', '/api/periods/' + encodeURIComponent(panelState[type].periodId) + '/categories',
        { section, label },
      );
      panelState[type].categories.push(cat);
      renderPanel(type);
    } catch (err) { alert('Erro: ' + err.message); }
  }

  function updateStatus(type, text, isError) {
    [type + '-edit-status', type + '-edit-status-footer'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.style.color = isError ? 'var(--red)' : 'var(--text-muted)';
    });
  }

  /**
   * Flush any pending debounced saves, then close the panel.
   * Called by both the top-right and bottom Salvar buttons.
   */
  /**
   * Navigate the month window by +6 or -6. Flushes pending autosaves
   * first so state.categories is up-to-date before the re-render.
   */
  async function moveWindow(type, delta) {
    const state = panelState[type];
    // Clamp so the new window fits within 0..(12 - WINDOW_SIZE). If user
    // starts at 1 (Feb-Jul) and clicks next, delta=+6 yields 7 which
    // would have been rejected before — now clamps to 6 (Jul-Dez).
    const maxStart = 12 - WINDOW_SIZE; // = 6
    const newStart = Math.max(0, Math.min(maxStart, state.windowStart + delta));
    if (newStart === state.windowStart) return; // already at the edge
    // Flush any pending debounce timers so saves land before re-render.
    const pendingIds = Object.keys(state.saveTimers);
    pendingIds.forEach((id) => {
      clearTimeout(state.saveTimers[id]);
      delete state.saveTimers[id];
    });
    if (pendingIds.length > 0) {
      updateStatus(type, 'Salvando...');
      try { await Promise.all(pendingIds.map((id) => doSave(type, id))); }
      catch (_e) { /* status already updated on error */ }
    }
    state.windowStart = newStart;
    renderPanel(type);
  }

  async function saveAndClose(type) {
    const state = panelState[type];
    const pendingIds = Object.keys(state.saveTimers);
    // Cancel the debounce timers so they don't fire again after we
    // trigger the save here.
    pendingIds.forEach((id) => {
      clearTimeout(state.saveTimers[id]);
      delete state.saveTimers[id];
    });
    if (pendingIds.length > 0) {
      updateStatus(type, 'Salvando...');
      try {
        await Promise.all(pendingIds.map((id) => doSave(type, id)));
      } catch (_e) { /* doSave already updates status on error */ }
    }
    // Toggle closes and reopens dashboard via bcPeriodLoader.
    state.open = false;
    const panel = ensurePanelContainer(type);
    if (panel) panel.style.display = 'none';
    const active = window.bcPeriods?.getActive(type);
    if (active && window.bcPeriodLoader) {
      await window.bcPeriodLoader.loadAndRender(type, active.id);
    }
  }

  // ---------- per-cell autosave ----------
  function scheduleSave(type, categoryId) {
    const state = panelState[type];
    if (state.finalizado) return;
    if (state.saveTimers[categoryId]) clearTimeout(state.saveTimers[categoryId]);
    updateStatus(type, 'Alterações pendentes...');
    state.saveTimers[categoryId] = setTimeout(() => doSave(type, categoryId), 600);
  }

  async function doSave(type, categoryId) {
    const state = panelState[type];
    const tr = document.querySelector('tr[data-category-id="' + categoryId + '"]');
    if (!tr) return;
    const cat = state.categories.find((c) => c.id === categoryId);
    if (!cat) return;
    // CRITICAL: start from the existing 12-month array so months OUTSIDE
    // the visible 6-month window are preserved. Previously this started
    // from [0, 0, ...] and only overwrote the 6 visible months, wiping
    // out saved values in the other 6 months every time the user typed.
    const monthly = Array.isArray(cat.monthly) && cat.monthly.length === 12
      ? cat.monthly.slice()
      : [0,0,0,0,0,0,0,0,0,0,0,0];
    const inputs = tr.querySelectorAll('input[data-month]');
    inputs.forEach((inp) => {
      const m = parseInt(inp.dataset.month, 10);
      if (cat.kind === 'money') monthly[m] = parseBRL(inp.value);
      else monthly[m] = inp.value ? parseInt(inp.value, 10) || 0 : 0;
    });
    updateStatus(type, 'Salvando...');
    try {
      const updated = await window.bcPeriods.api(
        'PATCH', '/api/categories/' + encodeURIComponent(categoryId) + '/monthly',
        { monthly },
      );
      cat.monthly = updated.monthly;
      state.lastSavedAt = Date.now();
      updateStatus(type, 'Salvo há poucos segundos');
    } catch (err) {
      updateStatus(type, 'Erro: ' + err.message, true);
    }
  }

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

  window.addEventListener('bc:period-changed', () => {
    ensureToggleButton('DRE');
    ensureToggleButton('FC');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => { ensureToggleButton('DRE'); ensureToggleButton('FC'); }, 100);
    });
  } else {
    setTimeout(() => { ensureToggleButton('DRE'); ensureToggleButton('FC'); }, 100);
  }
})();
