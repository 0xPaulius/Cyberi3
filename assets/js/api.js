// Thin fetch wrapper. Every endpoint returns JSON and uses the session cookie.

async function send(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Some responses (or a proxy error page) carry no JSON body.
  }

  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), {
      status: response.status,
      data,
    });
  }
  return data;
}

export const api = {
  get: (url) => send('GET', url),
  post: (url, body) => send('POST', url, body),
  put: (url, body) => send('PUT', url, body),
  patch: (url, body) => send('PATCH', url, body),
  del: (url) => send('DELETE', url),
};

export const formatTime = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
};
