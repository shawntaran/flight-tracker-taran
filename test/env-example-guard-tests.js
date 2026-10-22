// Pre-commit guard for .env*.example templates (tools/check-env-examples.js, .githooks/pre-commit).
// Credential-shaped values are built from parts so no scanner ever sees one in this file.
// Run: node test/env-example-guard-tests.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { findProblems } = require(path.join(ROOT, 'tools', 'check-env-examples.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const FAKE = {
  tg: '1234567890' + ':' + 'AAFakeTokenForGuardTests_abcdefghijk',
  gemini: 'AIza' + 'SyFakeKeyForGuardTests_0123456789ab',
  oauthSecret: 'GOCSPX' + '-FakeSecretForGuardTests',
  oauthId: '123456789012' + '-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com',
  sbPub: 'sb_' + 'publishable_FakeKeyForGuardTests',
  sbUrl: 'https://' + 'abcdefghijklmnopqrst' + '.supabase.co'
};

console.log('what counts as a real value');
test('every committed template passes as it is now', () => {
  ['.env.example', '.env.engine.example', 'local-assistant/.env.local-assistant.example'].forEach((f) =>
    assert.deepStrictEqual(findProblems(fs.readFileSync(path.join(ROOT, f), 'utf8')), [], f));
});
test('a value for a key, token, secret, client id, chat id, spreadsheet id or Supabase URL is refused', () => {
  const text = ['TG_BOT_TOKEN=x', 'GEMINI_API_KEY=whatever', 'GOOGLE_OAUTH_CLIENT_SECRET="quoted"', 'OPENSKY_CLIENT_ID=abc',
    'ALLOWED_CHAT_IDS=111,222', 'GOOGLE_SPREADSHEET_ID=abc', 'SUPABASE_URL=https://x.example', 'SUPABASE_SERVICE_ROLE_KEY=svc'].join('\n');
  assert.deepStrictEqual(findProblems(text).map((p) => p.line), [1, 2, 3, 4, 5, 6, 7, 8]);
});
test('blank sensitive settings and ordinary defaults are fine', () => {
  const text = ['# comment', 'TG_BOT_TOKEN=', 'GEMINI_API_KEY=   ', 'ALLOWED_CHAT_IDS=  # fill in', 'LLM_BASE_URL=http://127.0.0.1:11434/v1',
    'LLM_MODEL=your-model-name', 'GEMINI_MODEL=gemini-3.5-flash-lite', 'PREVIEW_SOURCE=flights', 'LLM_TIMEOUT_MS=30000'].join('\n');
  assert.deepStrictEqual(findProblems(text), []);
});
test('credential shapes are caught anywhere, also in comments and under harmless names', () => {
  const lines = ['# my token ' + FAKE.tg, 'LLM_MODEL=' + FAKE.gemini, 'NOTE=' + FAKE.oauthSecret, '# ' + FAKE.oauthId, 'X=' + FAKE.sbPub, 'URL_HINT=' + FAKE.sbUrl];
  const p = findProblems(lines.join('\n'));
  assert.deepStrictEqual(p.map((x) => x.line), [1, 2, 3, 4, 5, 6]);
  assert.ok(/Telegram bot token/.test(p[0].what) && /Google API key/.test(p[1].what) && /Supabase project URL/.test(p[5].what));
});
test('the report names the line and the setting, never the value', () => {
  const p = findProblems('GEMINI_API_KEY=' + FAKE.gemini);
  assert.ok(!JSON.stringify(p).includes(FAKE.gemini));
});

console.log('the hook, in a real git repository');
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-guard-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 'guard@test.invalid'); g('config', 'user.name', 'Guard Test'); g('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, '.githooks')); fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(path.join(ROOT, '.githooks', 'pre-commit'), path.join(dir, '.githooks', 'pre-commit'));
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  fs.copyFileSync(path.join(ROOT, 'tools', 'check-env-examples.js'), path.join(dir, 'tools', 'check-env-examples.js'));
  g('config', 'core.hooksPath', '.githooks');
  const commit = (msg) => spawnSync('git', ['commit', '-q', '-m', msg], { cwd: dir, encoding: 'utf8' });
  return { dir, g, commit };
}
let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (e) { gitOk = false; }
if (gitOk) {
  test('a template with a real key cannot be committed; a blank one can', () => {
    const r = tmpRepo();
    fs.writeFileSync(path.join(r.dir, '.env.example'), 'TG_BOT_TOKEN=\n');
    r.g('add', '.');
    assert.strictEqual(r.commit('blank template').status, 0, 'blank template commits');
    fs.writeFileSync(path.join(r.dir, '.env.example'), 'TG_BOT_TOKEN=' + FAKE.tg + '\n');
    r.g('add', '.env.example');
    const res = r.commit('oops');
    assert.notStrictEqual(res.status, 0, 'commit refused');
    assert.ok(/Commit refused/.test(res.stderr) && /\.env\.example:1 {2}TG_BOT_TOKEN has a value/.test(res.stderr), res.stderr);
    assert.ok(!res.stderr.includes(FAKE.tg), 'the value is not printed');
    assert.strictEqual(r.g('log', '--oneline').trim().split('\n').length, 1, 'only the blank commit exists');
  });
  test('a nested template (local-assistant/.env.local-assistant.example) is checked too', () => {
    const r = tmpRepo();
    fs.mkdirSync(path.join(r.dir, 'local-assistant'));
    fs.writeFileSync(path.join(r.dir, 'local-assistant', '.env.local-assistant.example'), 'GEMINI_API_KEY=' + FAKE.gemini + '\n');
    r.g('add', '.');
    assert.notStrictEqual(r.commit('nested').status, 0);
  });
  test('a real .env file force-added past .gitignore is refused', () => {
    const r = tmpRepo();
    fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env.*\n');
    fs.writeFileSync(path.join(r.dir, '.env.engine'), 'ADB_KEY=x\n');
    r.g('add', '-f', '.env.engine', '.gitignore');
    const res = r.commit('force');
    assert.ok(res.status !== 0 && /real settings file is being committed/.test(res.stderr), res.stderr);
  });
  test('the staged version is what counts: fixing the file on disk without re-adding still refuses', () => {
    const r = tmpRepo();
    fs.writeFileSync(path.join(r.dir, '.env.example'), 'ADB_KEY=real\n');
    r.g('add', '.');
    fs.writeFileSync(path.join(r.dir, '.env.example'), 'ADB_KEY=\n');
    assert.notStrictEqual(r.commit('staged').status, 0);
  });
}
test('npm install wires the hook up (package.json "prepare"); the hook file keeps Unix line endings', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.prepare, 'node tools/install-hooks.js');
  assert.ok(/\.githooks\/\* text eol=lf/.test(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')));
  assert.ok(!fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8').includes('\r'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
