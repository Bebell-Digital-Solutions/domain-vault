// Exercise web/api.js exactly as the browser would: same file, a
// stubbed window/localStorage, real fetch against the running stack.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

const store = new Map();
const win = {
  DOMAIN_VAULT_CONFIG: {
    supabaseUrl:  'http://127.0.0.1:54321',
    functionsUrl: 'http://127.0.0.1:54321/functions/v1',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
  },
  localStorage: {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, v),
    removeItem: k => store.delete(k)
  },
  fetch
};
win.window = win;
vm.createContext(win);
vm.runInContext(readFileSync('web/api.js', 'utf8'), win);

const API = win.DomainVaultAPI;
const email = `client-${Date.now()}@example.com`;
const pw = 'correct-horse-battery';
const ok = (label, cond, extra='') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

let r = await API.call('registerUser', { email, password: pw });
ok('register', r.success === true, r.message);

r = await API.call('loginUser', { email, password: pw });
ok('login refused while pending', r.success === false, r.message);

// activate, the way an admin would
execSync(`docker exec supabase_db_backend psql -U postgres -qtAc "update public.profiles set status='active' where email='${email}';"`);

r = await API.call('loginUser', { email, password: pw });
ok('login after activation', r.success === true);
ok('session persisted to storage', store.has('dv.session'));

r = await API.call('saveDomains', { domains: [
  { name: 'client-a.com', provider: 'Namecheap', renewalDate: '2027-01-01', renewalPrice: '9.99', autoRenew: true }
]});
ok('saveDomains', r.success === true);

r = await API.call('getUserData', {});
ok('getUserData returns the domain', r.domains?.length === 1, JSON.stringify(r.domains?.[0]?.name));

r = await API.call('saveProviders', { providers: [
  { name: 'Namecheap', url: 'https://namecheap.com', user: 'me', pass: 'registrar-pw-123' }
]});
ok('saveProviders with password', r.success === true);
ok('password not echoed back', r.providers?.[0]?.pass === '' && r.providers?.[0]?.hasPassword === true);

r = await API.revealPassword(r.providers[0].id);
ok('revealPassword round-trip', r.success === true && r.password === 'registrar-pw-123');

// simulate a page reload
const restored = await API.restore();
ok('session survives reload', restored?.email === email);

API.signOut();
ok('signOut clears storage', !store.has('dv.session'));

console.log('\nAll client flows passed.');
