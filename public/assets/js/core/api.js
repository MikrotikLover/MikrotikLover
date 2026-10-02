// JSON API client: CSRF header, uniform error handling, 401 -> login.
let csrf = '';
const listeners = { unauthorized: [] };

export class ApiError extends Error {
  constructor(message, status = 0, errors = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export function setCsrf(token) { csrf = token || ''; }
export function on(event, fn) { (listeners[event] ||= []).push(fn); }

export function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.append(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

export async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') opts.headers['X-CSRF-Token'] = csrf;
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('api/' + path.replace(/^\//, ''), opts);
  } catch {
    throw new ApiError('Network error - check your connection and try again.', 0);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`Server returned an invalid response (HTTP ${res.status}).`, res.status);
  }
  if (!json.ok) {
    const err = new ApiError(json.error || 'Request failed.', res.status, json.errors || {});
    if (res.status === 401) listeners.unauthorized.forEach((fn) => fn(err));
    throw err;
  }
  return json.data;
}

export const get = (path, params) => api('GET', path + qs(params));
export const post = (path, body) => api('POST', path, body ?? {});
export const put = (path, body) => api('PUT', path, body ?? {});
export const del = (path) => api('DELETE', path);
