/**
 * Hijacks the existing DRE/FC upload zones so that, when a period is
 * selected, the xlsx file is POSTed to /api/periods/:id/upload instead
 * of being parsed client-side into localStorage.
 *
 * If NO period is active, falls through to the v1 SPA handler (set up
 * inside app.html) — this keeps backward compatibility during the
 * migration phase.
 *
 * Also hijacks the "Baixar Template" button: when an active session
 * exists (user logged in) we fetch /api/template.xlsx (server-canonical)
 * instead of generating client-side.
 */
(function () {
  'use strict';

  function getCsrf() {
    const m = document.cookie.match(/(?:^|; )csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function uploadToServer(type, file) {
    const active = window.bcPeriods?.getActive(type);
    if (!active) return false; // caller should fall back to client-side

    const fd = new FormData();
    fd.append('file', file);

    const csrf = getCsrf();
    const headers = csrf ? { 'X-CSRF-Token': csrf } : {};
    const res = await fetch('/api/periods/' + encodeURIComponent(active.id) + '/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: fd,
    });
    let data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      const msg = (data && data.message) || 'Erro ao enviar arquivo';
      throw new Error(msg);
    }
    return true;
  }

  function installHandlers() {
    // The v1 SPA uses id `dre-file` / `fc-file` for the file input and
    // `dre-drop` / `fc-drop` for the drop zone. We wrap their change/drop
    // events to route to the server when applicable.
    ['DRE', 'FC'].forEach((type) => {
      const inputId = type === 'DRE' ? 'dre-file' : 'fc-file';
      const dropId = type === 'DRE' ? 'dre-drop' : 'fc-drop';
      const input = document.getElementById(inputId);
      const drop = document.getElementById(dropId);

      async function handleFile(file) {
        if (!file) return;
        const active = window.bcPeriods?.getActive(type);
        if (!active) {
          // No period selected — tell the user to pick one. Don't fall
          // through to client-side: the v1 upload stored in localStorage
          // which is being deprecated.
          alert('Selecione um período antes de fazer upload.');
          return;
        }
        try {
          await uploadToServer(type, file);
          // Reload the dashboard from the freshly imported entries.
          if (window.bcPeriodLoader) {
            await window.bcPeriodLoader.loadAndRender(type, active.id);
          }
        } catch (err) {
          alert('Erro: ' + err.message);
        }
      }

      if (input) {
        // Replace the v1 change listener: remove any existing by cloning.
        const clone = input.cloneNode(true);
        input.parentNode.replaceChild(clone, input);
        clone.addEventListener('change', () => handleFile(clone.files[0]));
      }
      if (drop) {
        // Same dance for the drop zone events.
        const clone = drop.cloneNode(true);
        drop.parentNode.replaceChild(clone, drop);
        clone.addEventListener('dragover', (e) => { e.preventDefault(); clone.classList.add('drag-over'); });
        clone.addEventListener('dragleave', () => clone.classList.remove('drag-over'));
        clone.addEventListener('drop', (e) => {
          e.preventDefault();
          clone.classList.remove('drag-over');
          const f = e.dataTransfer?.files?.[0];
          handleFile(f);
        });
      }
    });

    // Hijack the "Baixar Template" button by overwriting the global
    // downloadTemplate function defined in app.html's main script.
    window.downloadTemplate = function () {
      // Force a GET to /api/template.xlsx which streams the server-built
      // file. Browser handles Content-Disposition: attachment.
      window.location.href = '/api/template.xlsx';
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHandlers);
  } else {
    installHandlers();
  }
})();
