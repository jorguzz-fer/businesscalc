/**
 * One-time migration of localStorage DRE/FC snapshots into the server.
 *
 * Runs once per page load. If:
 *   1. User has data in localStorage (`bc-dre` or `bc-fc`), AND
 *   2. User has no periods yet on the server for that type,
 * it offers a banner at the top of the tab asking if they want to
 * import the local snapshot as a new period.
 *
 * On accept: creates a new period named "Migração" / year=currentYear,
 * then PUTs the entries from the localStorage payload, then deletes the
 * localStorage keys so the banner doesn't reappear next load.
 *
 * On dismiss: sets a flag in localStorage so the banner doesn't nag.
 *
 * This exists purely to preserve the data users created before Fase 1
 * went live. After a few weeks in production we can remove this file.
 */
(function () {
  'use strict';

  const DISMISS_KEY = 'bc-migration-dismissed';

  function getCsrf() {
    const m = document.cookie.match(/(?:^|; )csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (method !== 'GET') {
      const csrf = getCsrf();
      if (csrf) opts.headers['X-CSRF-Token'] = csrf;
    }
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.message) || 'Erro');
    return data;
  }

  function readLocalSnapshot(type) {
    try {
      const raw = localStorage.getItem(type === 'DRE' ? 'bc-dre' : 'bc-fc');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_e) { return null; }
  }

  function snapshotToEntries(snapshot) {
    // The v1 snapshot stored arrays by camelCase category key directly.
    // Only keep keys the server schema recognizes; ignore derived ones
    // (receitaLiq, lucroBruto, totalSaidas etc — the server recomputes).
    const WHITELIST = [
      'receita', 'deducoes', 'cmv', 'outrosCustos', 'equipamentos', 'provisao',
      'pessoal', 'beneficios', 'inss', 'proLabore', 'ferias', 'aluguel',
      'marketing', 'ti', 'diversas', 'manutPredial', 'exames', 'despFin',
      'pedidos', 'ticketMedio',
    ];
    const out = [];
    for (const key of WHITELIST) {
      const arr = snapshot[key];
      if (!Array.isArray(arr) || arr.length !== 12) continue;
      // Skip all-zero arrays to avoid cluttering the DB.
      if (!arr.some((v) => typeof v === 'number' && Number.isFinite(v) && v !== 0)) continue;
      out.push({
        category: key,
        monthly: arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)),
      });
    }
    return out;
  }

  function snapshotToMeta(snapshot) {
    const m = snapshot.metas;
    if (!m || typeof m !== 'object') return null;
    const out = {};
    const map = {
      metaReceita: 'receitaAnual',
      metaLucro: 'lucroAnual',
      metaMargemBruta: 'margemBrutaPct',
      metaMargemOp: 'margemOpPct',
      metaMargemLiq: 'margemLiqPct',
      metaTicket: 'ticketMedio',
      metaPedidos: 'pedidosMes',
    };
    for (const [src, dst] of Object.entries(map)) {
      const v = m[src];
      if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out[dst] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  function renderBanner(type, snapshot) {
    const tab = document.getElementById(type === 'DRE' ? 'tab-dre' : 'tab-fc');
    if (!tab) return;
    // Avoid duplicate.
    if (document.getElementById(type + '-migrate-banner')) return;

    const banner = document.createElement('div');
    banner.id = type + '-migrate-banner';
    banner.style.cssText = 'background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:var(--radius);padding:0.9rem 1.1rem;margin-bottom:1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap;';

    const text = document.createElement('div');
    text.style.cssText = 'flex:1;font-size:0.85rem;color:#78350f;line-height:1.5;';
    text.textContent = 'Detectamos dados de ' + type + ' salvos no seu navegador. Deseja importar como um novo período?';
    banner.appendChild(text);

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = 'Importar';
    importBtn.style.cssText = 'padding:0.5rem 1rem;border:none;border-radius:var(--radius-sm);background:var(--green);color:#fff;font-weight:600;cursor:pointer;font-family:inherit;font-size:0.82rem;';
    importBtn.addEventListener('click', () => runImport(type, snapshot, banner, importBtn));
    banner.appendChild(importBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Descartar';
    dismissBtn.style.cssText = 'padding:0.5rem 1rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);font-weight:500;cursor:pointer;font-family:inherit;font-size:0.82rem;';
    dismissBtn.addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY + '-' + type, '1');
      banner.remove();
    });
    banner.appendChild(dismissBtn);

    // Insert at the very top of the tab.
    if (tab.firstChild) tab.insertBefore(banner, tab.firstChild);
    else tab.appendChild(banner);
  }

  async function runImport(type, snapshot, banner, btn) {
    btn.disabled = true;
    btn.textContent = 'Importando...';
    try {
      const year = new Date().getFullYear();
      const period = await api('POST', '/api/periods', {
        name: 'Migração ' + type,
        year,
        type,
      });
      const entries = snapshotToEntries(snapshot);
      if (entries.length > 0) {
        await api('PUT', '/api/periods/' + encodeURIComponent(period.id) + '/entries', { entries });
      }
      const meta = snapshotToMeta(snapshot);
      if (meta) {
        await api('PUT', '/api/periods/' + encodeURIComponent(period.id) + '/meta', meta);
      }
      // Remove the local snapshot so this banner doesn't reappear.
      localStorage.removeItem(type === 'DRE' ? 'bc-dre' : 'bc-fc');
      localStorage.removeItem(type === 'DRE' ? 'bc-dre-file' : 'bc-fc-file');
      banner.remove();
      // Reload the period picker so the new period shows up.
      if (window.bcPeriods) await window.bcPeriods.reload();
      alert('Importado! Selecione o período "' + period.name + '" na lista.');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Importar';
      alert('Falha na importação: ' + err.message);
    }
  }

  async function check(type) {
    if (localStorage.getItem(DISMISS_KEY + '-' + type)) return;
    const snapshot = readLocalSnapshot(type);
    if (!snapshot) return;
    // Skip if we already have periods on the server for this type — the
    // user has presumably migrated (or never needed to).
    try {
      const resp = await api('GET', '/api/periods?type=' + type);
      if (Array.isArray(resp.periods) && resp.periods.length > 0) {
        // If they have periods + still have localStorage, don't autoprompt;
        // they can clean up manually. Just drop a dismissed flag.
        return;
      }
    } catch (_e) { return; }
    renderBanner(type, snapshot);
  }

  function boot() {
    check('DRE');
    check('FC');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
