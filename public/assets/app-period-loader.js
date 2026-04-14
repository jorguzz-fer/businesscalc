/**
 * Loads period entries + metas from the API and feeds them into the
 * existing renderDREDashboard / renderFCDashboard functions defined
 * in app.html's main <script>.
 *
 * Listens for bc:period-changed events (fired by app-periods.js).
 * When a period is selected:
 *   1. Fetch /api/periods/:id/entries  (raw entries + server-computed)
 *   2. Fetch /api/periods/:id/meta     (goals)
 *   3. Build a dashboard-shaped object matching the v1 SPA's internal
 *      format, so renderDREDashboard / renderFCDashboard Just Work.
 *   4. Call them and hide the empty-state upload area.
 *
 * When no period is selected: show empty state, hide dashboard,
 * destroy charts.
 */
(function () {
  'use strict';

  function q(id) { return document.getElementById(id); }

  /**
   * Convert the API response shape into the shape the v1 renderers expect.
   * v1 uses the raw entry keys directly as properties on `d`, PLUS computed
   * derived values. Our API returns { entries, computed } separately — merge
   * them into a flat object.
   */
  function toDREDashboardData(apiResp, metas) {
    const e = apiResp.entries || {};
    const c = apiResp.computed || {};
    const zeros = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return {
      // Raw entries (renderer references these by key for tables + donut)
      receita: e.receita || zeros.slice(),
      deducoes: e.deducoes || zeros.slice(),
      cmv: e.cmv || zeros.slice(),
      outrosCustos: e.outrosCustos || zeros.slice(),
      equipamentos: e.equipamentos || zeros.slice(),
      provisao: e.provisao || zeros.slice(),
      pessoal: e.pessoal || zeros.slice(),
      beneficios: e.beneficios || zeros.slice(),
      inss: e.inss || zeros.slice(),
      proLabore: e.proLabore || zeros.slice(),
      ferias: e.ferias || zeros.slice(),
      aluguel: e.aluguel || zeros.slice(),
      marketing: e.marketing || zeros.slice(),
      ti: e.ti || zeros.slice(),
      diversas: e.diversas || zeros.slice(),
      manutPredial: e.manutPredial || zeros.slice(),
      exames: e.exames || zeros.slice(),
      despFin: e.despFin || zeros.slice(),
      // Computed (renamed to match v1 property names)
      receitaLiq: c.receitaLiquida || zeros.slice(),
      custosDiretos: c.custosDiretos || zeros.slice(),
      lucroBruto: c.lucroBruto || zeros.slice(),
      despOp: c.despesasOperacionais || zeros.slice(),
      resultadoLiq: c.resultadoLiquido || zeros.slice(),
      margemBrutaMensal: c.margemBrutaMensal || zeros.slice(),
      margemLiqMensal: c.margemLiquidaMensal || zeros.slice(),
      // v1 renderer also reads margemOpMensal — synthesize from mb-ml if absent
      margemOpMensal: c.margemOpMensal || (c.margemLiquidaMensal || zeros.slice()),
      metas: metas || {},
    };
  }

  function toFCDashboardData(apiResp) {
    const e = apiResp.entries || {};
    const c = apiResp.computed || {};
    const zeros = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return {
      receita: e.receita || zeros.slice(),
      pedidos: e.pedidos || zeros.slice(),
      ticketMedio: e.ticketMedio || zeros.slice(),
      cmv: e.cmv || zeros.slice(),
      outrosCustos: e.outrosCustos || zeros.slice(),
      equipamentos: e.equipamentos || zeros.slice(),
      provisao: e.provisao || zeros.slice(),
      pessoal: e.pessoal || zeros.slice(),
      beneficios: e.beneficios || zeros.slice(),
      inss: e.inss || zeros.slice(),
      proLabore: e.proLabore || zeros.slice(),
      ferias: e.ferias || zeros.slice(),
      aluguel: e.aluguel || zeros.slice(),
      marketing: e.marketing || zeros.slice(),
      ti: e.ti || zeros.slice(),
      diversas: e.diversas || zeros.slice(),
      manutPredial: e.manutPredial || zeros.slice(),
      exames: e.exames || zeros.slice(),
      despFin: e.despFin || zeros.slice(),
      totalSaidas: c.totalSaidas || zeros.slice(),
      saldo: c.saldo || zeros.slice(),
    };
  }

  async function loadAndRender(type, periodId) {
    if (!window.bcPeriods) return;
    const api = window.bcPeriods.api;
    const empty = q(type === 'DRE' ? 'dre-empty' : 'fc-empty');
    const dashboard = q(type === 'DRE' ? 'dre-dashboard' : 'fc-dashboard');

    if (!periodId) {
      // Back to empty state.
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
      // Fall back to empty state so user isn't stuck.
      if (empty) empty.style.display = 'flex';
      if (dashboard) dashboard.style.display = 'none';
    }
  }

  window.addEventListener('bc:period-changed', (e) => {
    const { type, periodId } = e.detail || {};
    if (type !== 'DRE' && type !== 'FC') return;
    loadAndRender(type, periodId);
  });

  // Expose reload for the upload handler (next step) to call after a successful upload.
  window.bcPeriodLoader = { loadAndRender };
})();
