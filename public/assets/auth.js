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
})();
