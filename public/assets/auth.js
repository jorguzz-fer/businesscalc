// BusinessCalc — shared auth helpers.
// Tiny dep-free library used by login/signup/reset/verify pages.
(function () {
  'use strict';

  // Read an unsigned cookie by name. Our csrf cookie is not httpOnly
  // so JS can read it (required for the double-submit pattern).
  window.getCookie = function (name) {
    const prefix = name + '=';
    const parts = document.cookie.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.indexOf(prefix) === 0) {
        return decodeURIComponent(trimmed.substring(prefix.length));
      }
    }
    return null;
  };

  // Read ?foo=bar from current URL, URL-decoded.
  window.getQueryParam = function (name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  };

  // Fetch wrapper that:
  //   - sends JSON
  //   - includes cookies
  //   - adds X-CSRF-Token automatically for state-changing methods
  //   - parses JSON response + throws an Error with server message on non-2xx
  window.api = async function (method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = window.getCookie('csrf');
      if (csrf) opts.headers['X-CSRF-Token'] = csrf;
    }
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (_e) {
      // Empty or non-JSON response is okay on 204
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || 'Erro ao processar solicitação');
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  };

  // Bind a password-strength meter to an input element.
  window.bindStrengthMeter = function (inputEl, meterEl, labelEl) {
    const check = function () {
      const v = inputEl.value;
      let score = 0;
      if (v.length >= 12) score++;
      if (v.length >= 16) score++;
      if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      const labels = ['muito fraca', 'fraca', 'razoável', 'boa', 'forte', 'muito forte'];
      const colors = ['#dc2626', '#dc2626', '#d97706', '#d97706', '#16a34a', '#16a34a'];
      const pct = (Math.min(score, 5) / 5) * 100;
      meterEl.style.width = v.length === 0 ? '0%' : pct + '%';
      meterEl.style.background = colors[Math.min(score, 5)];
      labelEl.textContent = v.length === 0 ? '' : 'Senha ' + labels[Math.min(score, 5)];
    };
    inputEl.addEventListener('input', check);
  };

  // Two inline SVGs — eye and eye-slash. Self-contained so we don't depend
  // on emoji rendering across OSes (some show 👁 as monochrome, others
  // colored) and we don't pull an icon font.
  const EYE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  /**
   * Wraps a password input with a show/hide eye toggle button. The wrapper
   * is created in-place — call ONCE per input (idempotent).
   * Security note: visibility toggle is purely client-side; no password
   * is ever logged or sent anywhere by this helper.
   */
  window.bindPasswordToggle = function (inputEl) {
    if (!inputEl || inputEl.dataset.toggleBound === '1') return;
    inputEl.dataset.toggleBound = '1';

    // Wrap the input in a relative-positioned container.
    const wrap = document.createElement('div');
    wrap.className = 'password-wrap';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-toggle';
    btn.setAttribute('aria-label', 'Mostrar senha');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = EYE_SVG;
    btn.addEventListener('click', function () {
      const showing = inputEl.type === 'text';
      inputEl.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? EYE_SVG : EYE_OFF_SVG;
      btn.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Esconder senha');
      // Restore focus and caret to the input so the user can keep typing.
      inputEl.focus();
    });
    wrap.appendChild(btn);
  };
})();
