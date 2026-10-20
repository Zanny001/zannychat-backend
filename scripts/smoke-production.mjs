#!/usr/bin/env node
// Public endpoint smoke check. Never sends credentials or mutates production data.
// Retries transient Render cold starts / gateway errors, but preserves a hard
// failure if the backend or database is still unavailable after the retry budget.
const frontendUrl = (process.env.ZANNYCHAT_FRONTEND_URL || 'https://zannychat-app.netlify.app').replace(/\/$/, '');
const backendUrl = (process.env.ZANNYCHAT_BACKEND_URL || 'https://zannychat-backend.onrender.com').replace(/\/$/, '');
const attempts = Math.max(1, Math.min(5, Number.parseInt(process.env.SMOKE_ATTEMPTS || '3', 10) || 3));
const timeoutMs = Math.max(1000, Math.min(30000, Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '12000', 10) || 12000));
const retryDelayMs = Math.max(250, Math.min(10000, Number.parseInt(process.env.SMOKE_RETRY_DELAY_MS || '2000', 10) || 2000));
const targets = [
  { name: 'frontend', url: frontendUrl, expected: [200], validate: async (response) => {
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('text/html') ? null : 'expected an HTML app shell';
  } },
  { name: 'backend root', url: `${backendUrl}/`, expected: [200], validate: async (response) => {
    const body = await response.json().catch(() => null);
    return body?.service === 'zannychat-backend' && body?.status === 'ok' ? null : 'unexpected service discovery response';
  } },
  { name: 'backend liveness', url: `${backendUrl}/health/live`, expected: [200], validate: async (response) => {
    const body = await response.json().catch(() => null);
    return body?.service === 'zannychat-backend' && body?.status === 'ok' ? null : 'unexpected liveness response';
  } },
  { name: 'backend readiness', url: `${backendUrl}/health/ready`, expected: [200], validate: async (response) => {
    const body = await response.json().catch(() => null);
    return body?.status === 'ready' && body?.supabaseReachable === true ? null : 'Supabase readiness was not confirmed';
  } },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function check(target) {
  let lastFailure = 'no response';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target.url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'application/json, text/html;q=0.9' } });
      if (!target.expected.includes(response.status)) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const validationError = await target.validate(response);
        if (!validationError) {
          console.log(`PASS ${target.name}: HTTP ${response.status} (attempt ${attempt}/${attempts})`);
          return true;
        }
        lastFailure = validationError;
      }
    } catch (error) {
      lastFailure = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(error?.message || error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) {
      console.log(`RETRY ${target.name}: ${lastFailure}; waiting ${retryDelayMs}ms (attempt ${attempt}/${attempts})`);
      await sleep(retryDelayMs * attempt);
    }
  }
  console.error(`FAIL ${target.name}: ${lastFailure} after ${attempts} attempt(s) (${target.url})`);
  return false;
}

let failures = 0;
for (const target of targets) if (!(await check(target))) failures += 1;
if (failures) {
  console.error(`Smoke check failed: ${failures} endpoint(s) did not pass.`);
  process.exitCode = 1;
} else {
  console.log('All public production smoke checks passed.');
}
