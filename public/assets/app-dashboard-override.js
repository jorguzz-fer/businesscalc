/**
 * Re-renders the DRE/FC detail table dynamically from the API category
 * list, overriding the v1 SPA's hardcoded rows. Runs AFTER the v1
 * renderer has produced its table, so custom categories (items the user
 * added in the editor like "Dividendos") get their own row instead of
 * being lumped into a legacy bucket.
 *
 * Keeps the v1 KPI cards + charts untouched — they use aggregate
 * values that remain correct regardless of row count.
 */
(function () {
  'use strict';

  const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const MONTHS_LONG = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  // Per-type selected month. -1 = Ano (all 12 months); 0..11 = single month.
  const filterState = { DRE: -1, FC: -1 };

  const DRE_SECTION_ORDER = ['RECEITA', 'DEDUCOES', 'CUSTOS_DIRETOS', 'DESPESAS_OP'];
  const FC_SECTION_ORDER = ['ENTRADAS_FC', 'SAIDAS_FC'];
  const SECTION_TITLES = {
    RECEITA: 'RECEITA',
    DEDUCOES: 'DEDUÇÕES',
    CUSTOS_DIRETOS: 'CUSTOS DIRETOS',
    DESPESAS_OP: 'DESPESAS OPERACIONAIS',
    ENTRADAS_FC: 'ENTRADAS',
    SAIDAS_FC: 'SAÍDAS',
  };

  function sectionTitleFor(periodId, section) {
    // Honor the per-period section rename made in the editor panel
    // (stored in localStorage under the same key app-edit.js uses).
    const key = 'bc-section-title-' + periodId + '-' + section;
    return localStorage.getItem(key) || SECTION_TITLES[section];
  }

  function fmtMoney(v) {
    if (v === 0 || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    const rounded = Math.round(abs).toLocaleString('pt-BR', {
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
    return (v < 0 ? '-' : '') + 'R$' + rounded;
  }

  function fmtPct(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(1) + '%';
  }

  function sum12(a) {
    let s = 0;
    for (const v of a || []) s += Number(v) || 0;
    return s;
  }

  function sumArrays(...arrays) {
    const out = [0,0,0,0,0,0,0,0,0,0,0,0];
    for (const a of arrays) {
      if (!Array.isArray(a)) continue;
      for (let i = 0; i < 12; i++) out[i] += Number(a[i]) || 0;
    }
    return out;
  }

  function subArrays(a, b) {
    const out = [0,0,0,0,0,0,0,0,0,0,0,0];
    for (let i = 0; i < 12; i++) out[i] = (Number(a?.[i]) || 0) - (Number(b?.[i]) || 0);
    return out;
  }

  /**
   * Build one table row. When filterMonth is set (0..11), only that
   * month column is rendered plus the annual Total; otherwise all 12.
   */
  function buildRow(label, monthly, opts = {}) {
    const { cls = '', indent = true, isNegative = false, isPct = false, denom = null, filterMonth = -1 } = opts;
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    const tdL = document.createElement('td');
    tdL.textContent = label;
    if (indent) tdL.className = 'indent';
    tr.appendChild(tdL);
    const total = sum12(monthly);
    const monthRange = filterMonth >= 0 ? [filterMonth] : [0,1,2,3,4,5,6,7,8,9,10,11];
    for (const m of monthRange) {
      const td = document.createElement('td');
      let v = Number(monthly?.[m]) || 0;
      if (isPct) {
        const d = Number(denom?.[m]) || 0;
        td.textContent = d > 0 ? fmtPct((v / d) * 100) : '—';
      } else {
        td.textContent = fmtMoney(isNegative ? -v : v);
      }
      if (isNegative && v !== 0) td.className = 'negative';
      tr.appendChild(td);
    }
    const tdT = document.createElement('td');
    if (isPct) {
      const dt = sum12(denom);
      tdT.textContent = dt > 0 ? fmtPct((total / dt) * 100) : '—';
    } else {
      tdT.textContent = fmtMoney(isNegative ? -total : total);
    }
    if (isNegative && total !== 0) tdT.className = 'negative';
    tr.appendChild(tdT);
    return tr;
  }

  /**
   * Build the month-filter chip bar.
   * [Ano] [Jan] [Fev] [Mar] ... [Dez]
   * Click a chip to filter the table to that single month.
   */
  function buildFilterBar(type, onChange) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.35rem;padding:0.6rem 0.9rem;background:var(--bg-card);border:1px solid var(--border-light);border-radius:var(--radius-sm);margin-bottom:0.75rem;align-items:center;';
    const label = document.createElement('span');
    label.textContent = 'Filtrar mês:';
    label.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-right:0.35rem;font-weight:500;';
    bar.appendChild(label);

    const selected = filterState[type];
    const chipStyle = (active) =>
      'padding:0.35rem 0.75rem;border-radius:99px;font-size:0.75rem;font-weight:' + (active ? '700' : '500') + ';cursor:pointer;font-family:inherit;border:1px solid ' + (active ? 'var(--green)' : 'var(--border)') + ';background:' + (active ? 'var(--green)' : 'var(--bg-card)') + ';color:' + (active ? '#fff' : 'var(--text-secondary)') + ';transition:background 0.12s,color 0.12s;';

    // "Ano" chip (all months)
    const anoBtn = document.createElement('button');
    anoBtn.type = 'button';
    anoBtn.textContent = 'Ano';
    anoBtn.style.cssText = chipStyle(selected === -1);
    anoBtn.addEventListener('click', () => onChange(-1));
    bar.appendChild(anoBtn);

    for (let m = 0; m < 12; m++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = MONTHS[m];
      btn.title = MONTHS_LONG[m];
      btn.style.cssText = chipStyle(selected === m);
      btn.addEventListener('click', () => onChange(m));
      bar.appendChild(btn);
    }
    return bar;
  }

  /**
   * Build the thead header row honoring the month filter.
   * When filterMonth >= 0: Categoria | <MonthLong> | Total
   * Otherwise: Categoria | Jan..Dez | Total
   */
  function buildThead(filterMonth) {
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    const monthHeaders = filterMonth >= 0 ? [MONTHS_LONG[filterMonth]] : MONTHS;
    ['Categoria', ...monthHeaders, 'Total'].forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    return thead;
  }

  /**
   * Section band row. colspan adapts to the filter so the band stretches
   * edge-to-edge whether we're showing one month or all twelve.
   */
  function sectionHeaderRow(label, filterMonth) {
    const tr = document.createElement('tr');
    tr.className = 'section-header';
    const td = document.createElement('td');
    // Categoria + (1 month or 12) + Total
    td.colSpan = (filterMonth >= 0 ? 1 : 12) + 2;
    td.textContent = label;
    tr.appendChild(td);
    return tr;
  }

  /**
   * Build the dynamic DRE table.
   */
  function buildDRETable(categories, periodId, filterMonth = -1) {
    const byId = {};
    for (const c of categories || []) byId[c.id] = c;
    const bySection = {};
    for (const s of DRE_SECTION_ORDER) bySection[s] = [];
    for (const c of categories || []) {
      if (bySection[c.section]) bySection[c.section].push(c);
    }
    for (const s of DRE_SECTION_ORDER) {
      bySection[s].sort((a, b) => a.sortOrder - b.sortOrder);
    }

    const table = document.createElement('table');
    table.className = 'dre-tbl';
    table.appendChild(buildThead(filterMonth));

    const tbody = document.createElement('tbody');
    const fOpt = { filterMonth };

    // RECEITA
    tbody.appendChild(sectionHeaderRow(sectionTitleFor(periodId, 'RECEITA'), filterMonth));
    const receitaCats = bySection.RECEITA;
    const receitaSum = sumArrays(...receitaCats.map((c) => c.monthly));
    for (const c of receitaCats) tbody.appendChild(buildRow(c.label, c.monthly, fOpt));

    // DEDUCOES
    const deducoesCats = bySection.DEDUCOES;
    if (deducoesCats.length > 0) {
      tbody.appendChild(sectionHeaderRow(sectionTitleFor(periodId, 'DEDUCOES'), filterMonth));
      for (const c of deducoesCats) {
        tbody.appendChild(buildRow(c.label, c.monthly, { ...fOpt, isNegative: true }));
      }
    }
    const deducoesSum = sumArrays(...deducoesCats.map((c) => c.monthly));
    const receitaLiq = subArrays(receitaSum, deducoesSum);
    tbody.appendChild(buildRow('= Receita Líquida', receitaLiq, { ...fOpt, cls: 'calc-row', indent: false }));

    // CUSTOS_DIRETOS
    const custosCats = bySection.CUSTOS_DIRETOS;
    tbody.appendChild(sectionHeaderRow(sectionTitleFor(periodId, 'CUSTOS_DIRETOS'), filterMonth));
    for (const c of custosCats) {
      tbody.appendChild(buildRow(c.label, c.monthly, { ...fOpt, isNegative: true }));
    }
    const custosSum = sumArrays(...custosCats.map((c) => c.monthly));
    const lucroBruto = subArrays(receitaLiq, custosSum);
    tbody.appendChild(buildRow('= Lucro Bruto', lucroBruto, { ...fOpt, cls: 'calc-row', indent: false }));
    tbody.appendChild(buildRow('Margem Bruta %', lucroBruto, { ...fOpt, cls: 'pct-row', isPct: true, denom: receitaSum }));

    // DESPESAS_OP
    const despOpCats = bySection.DESPESAS_OP;
    tbody.appendChild(sectionHeaderRow(sectionTitleFor(periodId, 'DESPESAS_OP'), filterMonth));
    for (const c of despOpCats) {
      tbody.appendChild(buildRow(c.label, c.monthly, { ...fOpt, isNegative: true }));
    }
    const despOpSum = sumArrays(...despOpCats.map((c) => c.monthly));
    tbody.appendChild(buildRow('= Total Despesas Op', despOpSum, { ...fOpt, cls: 'calc-row', indent: false, isNegative: true }));

    const resultadoLiq = subArrays(lucroBruto, despOpSum);
    tbody.appendChild(buildRow('= RESULTADO LÍQUIDO', resultadoLiq, { ...fOpt, cls: 'resultado-row', indent: false }));
    tbody.appendChild(buildRow('Margem Líquida %', resultadoLiq, { ...fOpt, cls: 'pct-row', isPct: true, denom: receitaSum }));

    table.appendChild(tbody);
    return table;
  }

  /**
   * Build the dynamic FC table.
   */
  function buildFCTable(categories, periodId, filterMonth = -1) {
    const bySection = { ENTRADAS_FC: [], SAIDAS_FC: [] };
    for (const c of categories || []) {
      if (bySection[c.section]) bySection[c.section].push(c);
    }
    bySection.ENTRADAS_FC.sort((a, b) => a.sortOrder - b.sortOrder);
    bySection.SAIDAS_FC.sort((a, b) => a.sortOrder - b.sortOrder);

    const table = document.createElement('table');
    table.className = 'dre-tbl';
    table.appendChild(buildThead(filterMonth));

    const tbody = document.createElement('tbody');
    const fOpt = { filterMonth };
    tbody.appendChild(sectionHeaderRow(sectionTitleFor(periodId, 'ENTRADAS_FC'), filterMonth));
    for (const c of bySection.ENTRADAS_FC) tbody.appendChild(buildRow(c.label, c.monthly, fOpt));

    tbody.appendChild(sectionHeaderRow(sectionTitleFor(periodId, 'SAIDAS_FC'), filterMonth));
    for (const c of bySection.SAIDAS_FC) {
      tbody.appendChild(buildRow(c.label, c.monthly, { ...fOpt, isNegative: true }));
    }

    // Totals.
    // For saldo: entradas (money-kind only, excluding ticket) - saidas.
    const moneyInflows = bySection.ENTRADAS_FC
      .filter((c) => c.kind === 'money' && !/ticket/i.test(c.label))
      .map((c) => c.monthly);
    const entradas = sumArrays(...moneyInflows);
    const saidas = sumArrays(...bySection.SAIDAS_FC.map((c) => c.monthly));
    const saldo = subArrays(entradas, saidas);
    tbody.appendChild(buildRow('= Total Saídas', saidas, { ...fOpt, cls: 'calc-row', indent: false, isNegative: true }));
    tbody.appendChild(buildRow('= SALDO', saldo, { ...fOpt, cls: 'resultado-row', indent: false }));

    table.appendChild(tbody);
    return table;
  }

  /**
   * After the v1 renderers finish their DOM, swap the table.
   * Also inserts the month-filter chip bar above the table so the user
   * can zoom into a single month without scrolling 12 columns.
   */
  async function overrideTables() {
    if (!window.bcPeriods) return;
    for (const type of ['DRE', 'FC']) {
      const active = window.bcPeriods.getActive(type);
      if (!active) continue;
      try {
        const resp = await window.bcPeriods.api(
          'GET',
          '/api/periods/' + encodeURIComponent(active.id) + '/entries',
        );
        const cats = resp.categories || [];
        const container = document.getElementById(
          type === 'DRE' ? 'dre-table-container' : 'fc-table-container',
        );
        if (!container) continue;
        const filterMonth = filterState[type];
        const filterBar = buildFilterBar(type, (m) => {
          filterState[type] = m;
          overrideTables();
        });
        const fresh = type === 'DRE'
          ? buildDRETable(cats, active.id, filterMonth)
          : buildFCTable(cats, active.id, filterMonth);
        container.innerHTML = '';
        container.appendChild(filterBar);
        container.appendChild(fresh);
      } catch (err) {
        // non-blocking; v1 fallback is still on screen
        // eslint-disable-next-line no-console
        console.error('[dashboard-override] failed for', type, err);
      }
    }
  }

  // After the period loader has finished rendering the v1 dashboard,
  // override the detail table. bc:period-changed fires on every
  // selection, load, and close-editor — all the moments we need.
  window.addEventListener('bc:period-changed', () => {
    // Give the v1 renderer a tick to paint so our container exists.
    setTimeout(overrideTables, 120);
  });

  // Initial pass — cover the case where a period is already active on load.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(overrideTables, 900));
  } else {
    setTimeout(overrideTables, 900);
  }

  window.bcDashboardOverride = { overrideTables };
})();
