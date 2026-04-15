/**
 * Carrega valores agregados do DRE ativo nos campos da aba Calculadoras.
 *
 * Mapeamento (anual, somado dos 12 meses):
 *   - Ticket Médio → Faturamento (#ticket-faturamento) = total RECEITA
 *   - OPEX Salários (#opex-salarios) = Pessoal + Benefícios + INSS + Pró-Labore + Férias
 *   - OPEX Aluguel (#opex-aluguel) = Aluguel
 *   - OPEX Marketing (#opex-marketing) = Marketing
 *   - OPEX Outros (#opex-outros) = demais DESPESAS_OP + custos diretos (exceto CMV)
 *   - Resultado Final Impostos (#impostos) = Deduções e Impostos (DEDUCOES)
 *   - Resultado Final Juros (#juros) = Despesas Financeiras
 *   - CMV Custo unitário/Quantidade permanecem do usuário (unit-level).
 *   - Preço de venda / Quantidade da Receita idem.
 *
 * Quando roda:
 *   - Primeiro load da página
 *   - Usuário troca o período ativo (DRE)
 *   - Usuário clica na aba Calculadoras
 *
 * Se o usuário editar manualmente um campo na Calculadoras, o próximo
 * sync pode sobrescrever — aceito por design (DRE é fonte de verdade
 * quando existe um período ativo).
 */
(function () {
  'use strict';

  // IDs dos inputs da Calculadoras que vamos popular.
  const TARGETS = [
    'ticket-faturamento',
    'opex-salarios',
    'opex-aluguel',
    'opex-marketing',
    'opex-outros',
    'impostos',
    'juros',
  ];

  function formatBRLForInput(n) {
    if (!Number.isFinite(n) || n === 0) return '';
    const abs = Math.abs(n);
    const cents = Math.round(abs * 100);
    const int = Math.floor(cents / 100);
    const dec = String(cents % 100).padStart(2, '0');
    const intStr = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (n < 0 ? '-' : '') + intStr + ',' + dec;
  }

  function setMoney(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = formatBRLForInput(value);
  }

  function sumMonthly(cat) {
    if (!cat || !Array.isArray(cat.monthly)) return 0;
    return cat.monthly.reduce((s, v) => s + (Number(v) || 0), 0);
  }

  let lastSyncedPeriodId = null;

  async function syncFromDRE(force) {
    if (!window.bcPeriods) return;
    const active = window.bcPeriods.getActive('DRE');
    if (!active) return;
    if (!force && lastSyncedPeriodId === active.id) return;

    try {
      const resp = await window.bcPeriods.api(
        'GET',
        '/api/periods/' + encodeURIComponent(active.id) + '/entries',
      );
      const cats = resp.categories || [];

      // Helpers over the category list.
      const findByLabel = (rx) => cats.find((c) => rx.test(c.label));
      const sumByLabel = (rx) => sumMonthly(findByLabel(rx));
      const sumBySection = (sec) =>
        cats.filter((c) => c.section === sec).reduce((s, c) => s + sumMonthly(c), 0);

      // ---- Aggregate mappings ----
      const totalReceita = sumBySection('RECEITA');

      const pessoalTotal =
        sumByLabel(/^pessoal/i) +
        sumByLabel(/benef/i) +
        sumByLabel(/inss|fgts/i) +
        sumByLabel(/pr[óo]-?labore/i) +
        sumByLabel(/f[ée]rias/i);

      const aluguelTotal = sumByLabel(/aluguel/i);
      const marketingTotal = sumByLabel(/marketing/i);
      const tiTotal = sumByLabel(/\bti\b|tecnologia/i);
      const diversasTotal = sumByLabel(/diversas/i);
      const financTotal = sumByLabel(/financ/i);
      const manutTotal = sumByLabel(/manuten[çc][ãa]o\s*predial/i);
      const examesTotal = sumByLabel(/exame|sa[úu]de/i);

      // OPEX "Outros" = (DESPESAS_OP restante) + (CUSTOS_DIRETOS exceto CMV)
      const despOpTotal = sumBySection('DESPESAS_OP');
      const opexCaptured = pessoalTotal + aluguelTotal + marketingTotal + financTotal;
      const opexRemainderDespOp = Math.max(0, despOpTotal - opexCaptured);

      const custosDiretosTotal = sumBySection('CUSTOS_DIRETOS');
      const cmvTotal = sumByLabel(/cmv|log[íi]stica/i);
      const custosOutros = Math.max(0, custosDiretosTotal - cmvTotal);

      // ---- Fill fields ----
      setMoney('ticket-faturamento', totalReceita);
      setMoney('opex-salarios', pessoalTotal);
      setMoney('opex-aluguel', aluguelTotal);
      setMoney('opex-marketing', marketingTotal);
      setMoney('opex-outros', opexRemainderDespOp + custosOutros + tiTotal + diversasTotal + manutTotal + examesTotal);
      setMoney('impostos', sumBySection('DEDUCOES'));
      setMoney('juros', financTotal);

      // Trigger Calculadoras recompute.
      if (typeof window.calculate === 'function') {
        window.calculate();
      }

      lastSyncedPeriodId = active.id;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[DRE sync] falhou', err);
    }
  }

  /**
   * Clears the synced fields when there's no DRE period — so the
   * Calculadoras tab doesn't show ghosts of a previously-loaded period.
   */
  function clearSyncedFields() {
    TARGETS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (typeof window.calculate === 'function') window.calculate();
    lastSyncedPeriodId = null;
  }

  // ---- Triggers ----

  // Period changed on the DRE tab.
  window.addEventListener('bc:period-changed', (e) => {
    const detail = e.detail || {};
    if (detail.type !== 'DRE') return;
    if (detail.periodId) {
      lastSyncedPeriodId = null; // invalidate cache, force re-sync
      syncFromDRE(true);
    } else {
      clearSyncedFields();
    }
  });

  // User clicks the Calculadoras tab in the top nav.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('nav-tab') && t.dataset.tab === 'calculadoras') {
      // sync if we haven't synced yet for the current active period.
      setTimeout(() => syncFromDRE(false), 60);
    }
  });

  // Initial sync shortly after load (wait for bcPeriods to boot).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => syncFromDRE(false), 800));
  } else {
    setTimeout(() => syncFromDRE(false), 800);
  }

  // Expose for debugging / explicit UI action later.
  window.bcDreSync = { syncFromDRE, clearSyncedFields };
})();
