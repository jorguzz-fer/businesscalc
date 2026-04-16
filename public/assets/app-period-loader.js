/**
 * Bridges the new dynamic-categories API to the existing v1 SPA dashboard
 * renderers (renderDREDashboard / renderFCDashboard).
 *
 * Strategy: instead of collapsing by SECTION (which put every expense
 * under the "pessoal" slot and left the other rows empty), we match each
 * category's LABEL to the v1 key regex. Custom/renamed categories that
 * don't match any known pattern fall into the section's catch-all key
 * (diversas for DESPESAS_OP, outrosCustos for CUSTOS_DIRETOS) so their
 * values still reach the dashboard totals.
 */
(function () {
  'use strict';

  function q(id) { return document.getElementById(id); }
  const ZEROS = () => [0,0,0,0,0,0,0,0,0,0,0,0];

  /**
   * Accumulate a category's monthly array into a target monthly under
   * the same v1 key. Multiple matching categories sum (allows users who
   * added a "Pessoal - PJ" alongside "Pessoal (CLT)" to both go into
   * the pessoal slot without one overwriting the other).
   */
  function accum(target, monthly) {
    if (!Array.isArray(monthly)) return;
    for (let i = 0; i < 12; i++) target[i] += Number(monthly[i]) || 0;
  }

  // Label -> v1 slot regex. Order matters: the FIRST matching regex wins
  // for a given category, so more-specific patterns come first.
  const DRE_KEY_RX = [
    ['receita',      /receita/i],
    ['deducoes',     /dedu/i],
    ['cmv',          /cmv|log[íi]stica/i],
    ['equipamentos', /equipamentos/i],
    ['provisao',     /provis[ãa]o|manuten[çc][ãa]o\s*maq/i],
    ['outrosCustos', /outros\s*custos/i],
    // Despesas operacionais:
    ['inss',         /inss|fgts/i],
    ['beneficios',   /benef/i],
    ['proLabore',    /pr[óo]-?labore/i],
    ['ferias',       /f[ée]rias|13/i],
    ['aluguel',      /aluguel/i],
    ['marketing',    /marketing/i],
    ['ti',           /\bti\b|tecnologia/i],
    ['manutPredial', /manuten[çc][ãa]o.*predial/i],
    ['exames',       /exame|sa[úu]de/i],
    ['despFin',      /financ/i],
    ['pessoal',      /pessoal|sal[áa]rio/i],
    ['diversas',     /diversas/i],
  ];

  // Section -> catchall v1 key for custom/renamed items that match
  // nothing in DRE_KEY_RX. Keeps their values in the totals.
  const DRE_SECTION_FALLBACK = {
    RECEITA: 'receita',
    DEDUCOES: 'deducoes',
    CUSTOS_DIRETOS: 'outrosCustos',
    DESPESAS_OP: 'diversas',
  };

  function toDREDashboardData(apiResp, metas) {
    const c = apiResp.computed || {};
    const d = {
      receita: ZEROS(), deducoes: ZEROS(),
      cmv: ZEROS(), outrosCustos: ZEROS(), equipamentos: ZEROS(), provisao: ZEROS(),
      pessoal: ZEROS(), beneficios: ZEROS(), inss: ZEROS(), proLabore: ZEROS(), ferias: ZEROS(),
      aluguel: ZEROS(), marketing: ZEROS(), ti: ZEROS(), diversas: ZEROS(),
      manutPredial: ZEROS(), exames: ZEROS(), despFin: ZEROS(),
    };
    for (const cat of apiResp.categories || []) {
      let matched = false;
      for (const [key, rx] of DRE_KEY_RX) {
        if (rx.test(cat.label) && d[key]) {
          accum(d[key], cat.monthly);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const fallback = DRE_SECTION_FALLBACK[cat.section];
        if (fallback && d[fallback]) accum(d[fallback], cat.monthly);
      }
    }
    // Server-authoritative computed values flow through unchanged.
    return {
      ...d,
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

  // FC uses the same expense keys as DRE for the "saídas" side, plus
  // pedidos / ticketMedio / receita on the inflow side.
  const FC_INFLOW_RX = [
    ['pedidos',     /pedido/i],
    ['ticketMedio', /ticket/i],
    ['receita',     /receita|venda/i],
  ];

  function toFCDashboardData(apiResp) {
    const c = apiResp.computed || {};
    const d = {
      receita: ZEROS(), pedidos: ZEROS(), ticketMedio: ZEROS(),
      cmv: ZEROS(), outrosCustos: ZEROS(), equipamentos: ZEROS(), provisao: ZEROS(),
      pessoal: ZEROS(), beneficios: ZEROS(), inss: ZEROS(), proLabore: ZEROS(), ferias: ZEROS(),
      aluguel: ZEROS(), marketing: ZEROS(), ti: ZEROS(), diversas: ZEROS(),
      manutPredial: ZEROS(), exames: ZEROS(), despFin: ZEROS(),
    };
    for (const cat of apiResp.categories || []) {
      if (cat.section === 'ENTRADAS_FC') {
        let matched = false;
        for (const [key, rx] of FC_INFLOW_RX) {
          if (rx.test(cat.label) && d[key]) {
            accum(d[key], cat.monthly);
            matched = true;
            break;
          }
        }
        if (!matched) accum(d.receita, cat.monthly);
      } else if (cat.section === 'SAIDAS_FC') {
        let matched = false;
        for (const [key, rx] of DRE_KEY_RX) {
          if (rx.test(cat.label) && d[key]) {
            accum(d[key], cat.monthly);
            matched = true;
            break;
          }
        }
        if (!matched) accum(d.diversas, cat.monthly);
      }
    }
    return {
      ...d,
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
