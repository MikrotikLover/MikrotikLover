/**
 * API client. Every call goes to api/index.php?r=<route> with:
 *  - same-origin cookies (PHP session), cache: 'no-store'
 *  - X-CSRF-Token on every request (refreshed automatically on 419)
 *  - X-Lang so server validation messages come back in the UI language
 * Errors are thrown as ApiError {status, message, errors, code}; `errors`
 * maps field names to messages and is understood by enterNav.showErrors().
 */
import { getLang, t } from './i18n.js';

export class ApiError extends Error {
  constructor(message, status = 0, errors = null, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
    this.code = code;
  }
}

let csrf = null;
const handlers = { unauthorized: null, passwordChange: null };

export function setCsrf(token) {
  if (token) csrf = token;
}

/** Register app-level handlers: unauthorized(message), passwordChange(). */
export function onApiEvent(name, fn) {
  handlers[name] = fn;
}

async function request(method, route, { body, query, form, retry = true } = {}) {
  const params = new URLSearchParams({ r: route });
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.append(k, v);
    }
  }
  const headers = { Accept: 'application/json', 'X-Lang': getLang() };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`api/index.php?${params}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(t('error.network'), 0, null, 'network');
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON (PHP fatal / proxy page) */
  }

  if (res.ok && json && json.ok) {
    if (json.data && typeof json.data === 'object' && json.data.csrf) setCsrf(json.data.csrf);
    return json.data;
  }

  if (res.status === 419 && retry) {
    await refreshCsrf();
    return request(method, route, { body, query, form, retry: false });
  }
  if (res.status === 401 && !route.startsWith('auth/') && route !== 'setup/admin') {
    handlers.unauthorized?.(json?.message);
  }
  if (res.status === 403 && json?.code === 'password_change_required') {
    handlers.passwordChange?.();
  }
  throw new ApiError(json?.message || t('error.generic'), res.status, json?.errors || null, json?.code || null);
}

export async function refreshCsrf() {
  return request('GET', 'auth/bootstrap', { retry: false });
}

export const api = {
  get: (route, query) => request('GET', route, { query }),
  post: (route, body = {}) => request('POST', route, { body }),
  put: (route, body = {}) => request('PUT', route, { body }),
  del: (route) => request('DELETE', route, { body: {} }),
  /** multipart/form-data upload (FormData), e.g. design images */
  upload: (route, formData) => request('POST', route, { form: formData }),
};

export default api;
