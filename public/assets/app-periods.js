/**
 * BusinessCalc — server-backed periods for the DRE/FC tabs.
 *
 * This module:
 *   - lists the user's periods via GET /api/periods?type=...
 *   - creates new periods via POST /api/periods
 *   - selects one and exposes it as window.bcActivePeriod
 *   - notifies the main dashboard when the selection changes
 *
 * It REPLACES the localStorage-based persistence for DRE/FC tabs.
 * The period picker becomes the entry point for any DRE or FC work —
 * you pick a period, then edit.
 *
 * Expected DOM targets (inserted by renderPeriodPicker):
 *   #dre-period-bar   — container inside the DRE tab header area
 *   #fc-period-bar    — container inside the FC tab header area
 */
(function () {
  'use strict';

  // ---------- tiny dep-free fetch wrapper with CSRF ----------
  function getCookie(name) {
    const parts = document.cookie.split(';');
    for (const part of parts) {
      const t = part.trim();
      if (t.startsWith(name + '=')) return decodeURIComponent(t.substring(name.length + 1));
    }
    return null;
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = getCookie('csrf');
      if (csrf) opts.headers['X-CSRF-Token'] = csrf;
    }
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      const err = new Error((data && data.message) || 'Erro ao processar solicitação');
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  // ---------- state ----------
  const state = {
    DRE: { periods: [], activeId: null },
    FC:  { periods: [], activeId: null },
  };

  // ---------- UI helpers ----------
  function el(tag, props, ...children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k === 'on' && typeof v === 'object') {
          for (const [evt, fn] of Object.entries(v)) n.addEventListener(evt, fn);
        } else if (k in n) n[k] = v;
        else n.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  // Format "Jul/2024" etc for compact display.
  function fmtPeriod(p) { return p.name + ' · ' + p.year; }

  // ---------- renderers ----------
  function renderPicker(type, container) {
    container.innerHTML = '';
    const s = state[type];

    const wrap = el('div', {
      style: {
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '0.8rem 1rem',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        marginBottom: '1rem',
      },
    });

    const label = el('span', {
      style: { fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)' },
    }, 'Período');

    const select = el('select', {
      style: {
        flex: '1',
        minWidth: '200px',
        padding: '0.45rem 0.6rem',
        border: '1.5px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-input)',
        fontFamily: 'inherit',
        fontSize: '0.85rem',
        cursor: 'pointer',
      },
    });

    if (s.periods.length === 0) {
      const opt = el('option', { value: '' }, 'Nenhum período criado ainda');
      opt.disabled = true;
      opt.selected = true;
      select.appendChild(opt);
      select.disabled = true;
    } else {
      const placeholder = el('option', { value: '' }, '— selecione um período —');
      placeholder.disabled = true;
      if (!s.activeId) placeholder.selected = true;
      select.appendChild(placeholder);
      for (const p of s.periods) {
        const opt = el('option', { value: p.id }, fmtPeriod(p) + (p.status === 'FINALIZED' ? ' (finalizado)' : ''));
        if (p.id === s.activeId) opt.selected = true;
        select.appendChild(opt);
      }
    }
    select.addEventListener('change', () => setActive(type, select.value));

    const newBtn = el('button', {
      type: 'button',
      style: {
        padding: '0.5rem 1rem',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--green)',
        color: '#fff',
        fontSize: '0.8rem',
        fontWeight: '600',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      on: { click: () => openCreateDialog(type) },
    }, '+ Novo período');

    const deleteBtn = el('button', {
      type: 'button',
      style: {
        padding: '0.5rem 1rem',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        color: 'var(--text-secondary)',
        fontSize: '0.8rem',
        fontWeight: '500',
        cursor: s.activeId ? 'pointer' : 'not-allowed',
        fontFamily: 'inherit',
        opacity: s.activeId ? '1' : '0.4',
      },
      on: { click: () => deleteActive(type) },
    }, 'Apagar');
    if (!s.activeId) deleteBtn.disabled = true;

    // Secondary upload button — triggers the file input hidden in the
    // empty state so users can still import XLSX without seeing the
    // big upload card.
    const uploadBtn = el('button', {
      type: 'button',
      style: {
        padding: '0.5rem 0.9rem',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-input)',
        color: 'var(--text-secondary)',
        fontSize: '0.78rem',
        fontWeight: '500',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      title: 'Importar arquivo .xlsx para o período atual',
      on: {
        click: () => {
          const input = document.getElementById(type === 'DRE' ? 'dre-file' : 'fc-file');
          if (input) input.click();
        },
      },
    }, '⬆ Importar');

    wrap.appendChild(label);
    wrap.appendChild(select);
    wrap.appendChild(newBtn);
    wrap.appendChild(uploadBtn);
    wrap.appendChild(deleteBtn);
    container.appendChild(wrap);
  }

  // ---------- create dialog ----------
  function openCreateDialog(type) {
    // Simple prompt-based flow (no modal dependency).
    const name = prompt('Nome do período (ex: "DRE 2024"):', type + ' ' + new Date().getFullYear());
    if (!name) return;
    const yearStr = prompt('Ano:', String(new Date().getFullYear()));
    if (!yearStr) return;
    const year = parseInt(yearStr, 10);
    if (!Number.isFinite(year) || year < 1990 || year > 2100) {
      alert('Ano inválido.');
      return;
    }
    api('POST', '/api/periods', { name, year, type })
      .then((p) => {
        state[type].periods.unshift(p);
        setActive(type, p.id);
      })
      .catch((err) => alert('Erro ao criar: ' + err.message));
  }

  // ---------- delete ----------
  function deleteActive(type) {
    const s = state[type];
    if (!s.activeId) return;
    const active = s.periods.find((p) => p.id === s.activeId);
    if (!active) return;
    if (!confirm('Apagar o período "' + active.name + '"? Essa ação não pode ser desfeita.')) return;
    api('DELETE', '/api/periods/' + encodeURIComponent(active.id))
      .then(() => {
        s.periods = s.periods.filter((p) => p.id !== active.id);
        s.activeId = null;
        refresh(type);
        // Tell the dashboard to clear itself.
        window.dispatchEvent(new CustomEvent('bc:period-changed', { detail: { type, periodId: null } }));
      })
      .catch((err) => alert('Erro ao apagar: ' + err.message));
  }

  // ---------- selection ----------
  function setActive(type, id) {
    state[type].activeId = id || null;
    refresh(type);
    window.dispatchEvent(new CustomEvent('bc:period-changed', {
      detail: { type, periodId: id || null },
    }));
  }

  function refresh(type) {
    const container = document.getElementById(type === 'DRE' ? 'dre-period-bar' : 'fc-period-bar');
    if (container) renderPicker(type, container);
  }

  // ---------- bootstrap ----------
  async function init() {
    for (const type of ['DRE', 'FC']) {
      try {
        const res = await api('GET', '/api/periods?type=' + type);
        state[type].periods = res.periods || [];
      } catch (err) {
        console.error('Failed to load ' + type + ' periods', err);
      }
      refresh(type);
    }
    // Auto-select most recent period per tab so the dashboard loads
    // directly on first visit instead of showing the empty state.
    // API orders by year desc + createdAt desc, so periods[0] IS the
    // most recent. Fire bc:period-changed so the loader + DRE-sync
    // modules pick it up.
    for (const type of ['DRE', 'FC']) {
      const s = state[type];
      if (s.periods.length > 0 && !s.activeId) {
        s.activeId = s.periods[0].id;
        refresh(type);
        window.dispatchEvent(new CustomEvent('bc:period-changed', {
          detail: { type, periodId: s.activeId },
        }));
      }
    }
  }

  // Public API.
  window.bcPeriods = {
    getActive(type) {
      const s = state[type];
      if (!s.activeId) return null;
      return s.periods.find((p) => p.id === s.activeId) ?? null;
    },
    reload() { return init(); },
    api,
  };

  // Kick off after DOMContentLoaded if it hasn't happened already.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
