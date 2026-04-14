/**
 * Bridges the new dynamic-categories API to the existing v1 SPA dashboard
 * renderers (renderDREDashboard / renderFCDashboard).
 *
 * The v1 renderers expect a flat object keyed by hardcoded category names
 * (receita, deducoes, cmv, etc). Now categories are user-defined and live
 * under section enums (RECEITA, CUSTOS_DIRETOS, ...).
 *
 * Strategy: collapse categories by section into the v1-compatible keys.
 * Per-category granularity is preserved in the EDIT panel; the dashboard
 * shows section-level totals + the server's computed values (which are
 * already section-aware, so totals/lucro/margens stay accurate).
 */
(function () {
  'use strict';

  function q(id) { return document.getElementById(id); }
  const ZEROS = () => [0,0,0,0,0,0,0,0,0,0,0,0];

  // sum many monthly arrays element-wise.
  function sum12(arrays) {
    const out = ZEROS();
    for (const a of arrays) {
      if (!Array.isArray(a)) continue;
      for (let i = 0; i < 12; i++) out[i] += (Number(a[i]) || 0);
    }
    return out;
  }

  function bySection(categories) {
    const map = { RECEITA: [], DEDUCOES: [], CUSTOS_DIRETOS: [], DESPESAS_OP: [], ENTRADAS_FC: [], SAIDAS_FC: [] };
    for (const c of categories || []) {
      if (map[c.section]) map[c.section].push(c);
    }
    return map;
  }

  function toDREDashboardData(apiResp, metas) {
    const c = apiResp.computed || {};
    const sec = bySection(apiResp.categories);
    // For the v1 renderer's DRE table & donut, expose section-level sums
    // under the legacy property names. A single "cmv" key holding the sum
    // of CUSTOS_DIRETOS preserves the chart shape; the EDIT panel shows
    // per-item granularity for editing.
    const cmvSum = sum12(sec.CUSTOS_DIRETOS.map((x) => x.monthly));
    const despOpSum = sum12(sec.DESPESAS_OP.map((x) => x.monthly));
    return {
      // Inputs (collapsed by section).
      receita: sum12(sec.RECEITA.map((x) => x.monthly)),
      deducoes: sum12(sec.DEDUCOES.map((x) => x.monthly)),
      cmv: cmvSum,
      // Other CUSTOS_DIRETOS items go to zero so the donut doesn't double-count.
      outrosCustos: ZEROS(), equipamentos: ZEROS(), provisao: ZEROS(),
      pessoal: despOpSum,
      // Other DESPESAS_OP go zero to avoid double-counting.
      beneficios: ZEROS(), inss: ZEROS(), proLabore: ZEROS(), ferias: ZEROS(),
      aluguel: ZEROS(), marketing: ZEROS(), ti: ZEROS(), diversas: ZEROS(),
      manutPredial: ZEROS(), exames: ZEROS(), despFin: ZEROS(),
      // Computed (server-authoritative).
      receitaLiq: c.receitaLiquida || ZEROS(),
      custosDiretos: c.custosDiretos || ZEROS(),
      lucroBruto: c.lucroBruto || ZEROS(),
      despOp: c.despesasOperacionais || ZEROS(),
      resultadoLiq: c.resultadoLiquido || ZEROS(),
      margemBrutaMensal: c.margemBrutaMensal || ZEROS(),
      margemLiqMensal: c.margemLiquidaMensal || ZEROS(),
      margemOpMensal: c.margemLiquidaMensal || ZEROS(),
      metas: metas || {},
    };
  }

  function toFCDashboardData(apiResp) {
    const c = apiResp.computed || {};
    const sec = bySection(apiResp.categories);
    // Identify the receita line in ENTRADAS_FC by money kind + label match.
    const receitaCat = sec.ENTRADAS_FC.find((x) => /receita|vendas/i.test(x.label));
    const pedidosCat = sec.ENTRADAS_FC.find((x) => x.kind === 'count');
    const ticketCat = sec.ENTRADAS_FC.find((x) => /ticket/i.test(x.label));
    const saidasSum = sum12(sec.SAIDAS_FC.map((x) => x.monthly));
    return {
      receita: receitaCat?.monthly || ZEROS(),
      pedidos: pedidosCat?.monthly || ZEROS(),
      ticketMedio: ticketCat?.monthly || ZEROS(),
      cmv: saidasSum, // collapse all saídas under cmv for the v1 donut
      outrosCustos: ZEROS(), equipamentos: ZEROS(), provisao: ZEROS(),
      pessoal: ZEROS(), beneficios: ZEROS(), inss: ZEROS(), proLabore: ZEROS(),
      ferias: ZEROS(), aluguel: ZEROS(), marketing: ZEROS(), ti: ZEROS(),
      diversas: ZEROS(), manutPredial: ZEROS(), exames: ZEROS(), despFin: ZEROS(),
      totalSaidas: c.saidas || ZEROS(),
      saldo: c.saldo || ZEROS(),
    };
  }

  async function loadAndRender(type, periodId) {
    if (!window.bcPeriods) return;
    const api = window.bcPeriods.api;
    const empty = q(type === 'DRE' ? 'dre-empty' : 'fc-empty');
    const dashboard = q(type === 'DRE' ? 'dre-dashboard' : 'fc-dashboard');

    if (!periodId) {
      if (empty) empty.style.display = 'flex';
      if (dashboard) dashboard.style.display = 'none';
      return;
    }

    try {
      const [entriesResp, metaResp] = await Promise.all([
        api('GET', '/api/periods/' + encodeURIComponent(periodId) + '/entries'),
        api('GET', '/api/periods/' + encodeURIComponent(periodId) + '/meta').catch(() => null),
      ]);
      const active = window.bcPeriods.getActive(type);
      const label = active ? active.name + ' · ' + active.year : 'período';

      if (empty) empty.style.display = 'none';
      if (dashboard) dashboard.style.display = 'block';

      if (type === 'DRE' && typeof window.renderDREDashboard === 'function') {
        window.renderDREDashboard(toDREDashboardData(entriesResp, metaResp), label);
      } else if (type === 'FC' && typeof window.renderFCDashboard === 'function') {
        window.renderFCDashboard(toFCDashboardData(entriesResp), label);
      }
    } catch (err) {
      console.error('[period-loader] failed', err);
      if (empty) empty.style.display = 'flex';
      if (dashboard) dashboard.style.display = 'none';
    }
  }

  window.addEventListener('bc:period-changed', (e) => {
    const { type, periodId } = e.detail || {};
    if (type !== 'DRE' && type !== 'FC') return;
    loadAndRender(type, periodId);
  });

  window.bcPeriodLoader = { loadAndRender };
})();
