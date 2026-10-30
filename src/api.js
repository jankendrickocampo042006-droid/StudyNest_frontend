const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

let csrfToken = '';

export async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const isFormData = options.body instanceof FormData;
  const response = await fetch(`${apiBase}/api${path}`, {
    ...options,
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('StudyNest API returned an invalid response. Check the PHP API route and server logs.');
    }
  }
  if (payload.csrf_token) csrfToken = payload.csrf_token;
  if (!response.ok) {
    const error = new Error(payload.error || `StudyNest API request failed (${response.status}).`);
    error.payload = payload;
    throw error;
  }
  return payload;
}