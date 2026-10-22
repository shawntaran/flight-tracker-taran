#!/usr/bin/env node
// Local setup check: `npm run doctor`. Offline only: no network, no real API keys, no provider calls.
// It checks the repository, not your Google project. For that, use the spreadsheet menu
// "Check setup (no API calls)".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const results = [];
const ok = (area, msg) => results.push(['ok', area, msg]);
const warn = (area, msg) => results.push(['warn', area, msg]);
const fail = (area, msg) => results.push(['error', area, msg]);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 1. Tools
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok('Node.js', 'v' + process.versions.node);
else fail('Node.js', 'v' + process.versions.node + ' found; 18 or newer required');
const clasp = spawnSync('clasp', ['--version'], { encoding: 'utf8', shell: true });
if (clasp.status === 0) ok('clasp', 'installed (' + String(clasp.stdout).trim() + ')');
else warn('clasp', 'not installed. Needed only to deploy with clasp: npm install -g @google/clasp');

// 2. Expected files
const expected = ['src/appsscript.json', 'src/AdbClient.js', 'src/Alerts.js', 'src/Config.js', 'src/Diagnostics.js',
  'src/Dashboard.js', 'src/DashboardPage.html', 'src/Grouping.js', 'src/Menu.js', 'src/Providers.js', 'src/Sheet.js', 'src/Tracker.js', 'src/Util.js',
  'test/run-tests.js', 'test/adb-tests.js', 'test/setup-tests.js', 'test/dashboard-tests.js', 'test/telegram-tests.js', 'test/sheet-source-tests.js', 'test/engine-tests.js', 'test/tracker-control-tests.js', 'tools/tracker-control.js', 'engine/core.js', 'engine/run.js', 'engine/supabase-store.js', 'api/cron.js', 'vercel.json', 'tools/sheet-source.js', 'local-assistant/src/main.js', 'local-assistant/test/assistant-tests.js', 'local-assistant/.env.local-assistant.example', 'local-assistant/README.md', 'README.md', 'AUDIT.md', 'PROJECT_STATUS.md',
  '.gitignore', '.env.example', '.clasp.json.example', 'package.json'];
const missing = expected.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) fail('Files', 'missing: ' + missing.join(', '));
else ok('Files', expected.length + ' expected files present');

// 3. Manifest
try {
  const m = JSON.parse(read('src/appsscript.json'));
  const need = ['https://www.googleapis.com/auth/spreadsheets.currentonly', 'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/script.container.ui'];
  const lacking = need.filter((s) => !(m.oauthScopes || []).includes(s));
  if (m.runtimeVersion !== 'V8') fail('Manifest', 'runtimeVersion must be V8');
  else if (m.timeZone !== 'Asia/Kolkata') fail('Manifest', 'timeZone must be Asia/Kolkata');
  else if (lacking.length) fail('Manifest', 'missing scopes: ' + lacking.join(', '));
  else ok('Manifest', 'V8, Asia/Kolkata, ' + m.oauthScopes.length + ' scopes');
} catch (e) { fail('Manifest', 'src/appsscript.json unreadable: ' + e.message); }

// 3b. Apps Script loads files in an order you don't control: each file's top-level code must only use
//     its own definitions. Loading every file alone in an empty sandbox proves that.
const loadOrderProblems = [];
fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).forEach((f) => {
  try { vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), vm.createContext({ console: { log() {}, error() {} } }), { filename: f }); }
  catch (e) { loadOrderProblems.push(f + ' (' + e.message + ')'); }
});
if (loadOrderProblems.length) fail('Load order', 'top-level code depends on another file: ' + loadOrderProblems.join('; '));
else ok('Load order', 'every src file loads on its own (Apps Script file order cannot break it)');

// 4. Secret names: every name the code reads is registered, documented and in .env.example
const ctx = vm.createContext({ console: { log() {}, error() {} } });
fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort().forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
const registry = ctx.SECRETS.map((s) => s.name);
const used = new Set();
fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).forEach((f) => {
  const s = fs.readFileSync(path.join(SRC, f), 'utf8');
  for (const m of s.matchAll(/(?:secret|secret_safe_|env\.secret)\('([A-Z0-9_]+)'\)/g)) used.add(m[1]);
});
const unregistered = [...used].filter((n) => !registry.includes(n));
if (unregistered.length) fail('Secret names', 'read in code but not in SECRETS: ' + unregistered.join(', '));
else ok('Secret names', 'code reads ' + [...used].sort().join(', ') + '; all registered');
const envEx = fs.existsSync(path.join(ROOT, '.env.example')) ? read('.env.example') : '';
const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? read('README.md') : '';
const undocumented = registry.filter((n) => !new RegExp('^' + n + '=', 'm').test(envEx) || !readme.includes(n));
if (undocumented.length) fail('Secret names', 'not in .env.example or README: ' + undocumented.join(', '));
else ok('Secret names', 'all ' + registry.length + ' documented in README and .env.example');

// 5. .env.example holds placeholders only
const filled = envEx.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=\S/.test(l));
if (filled.length) fail('.env.example', 'has values on ' + filled.length + ' line(s); it must contain placeholders only');
else ok('.env.example', 'placeholders only');

// 6. .gitignore behaviour, checked with git in a throwaway repository. That repository is isolated from
//    the caller's git environment: inherited GIT_DIR/GIT_WORK_TREE (set by some tools and sandboxes) and
//    global/system config such as core.excludesFile would otherwise change or break the answers.
//    git exit codes: 0 = ignored, 1 = not ignored, anything else = git failed. A failure is reported as
//    "could not check", never as a list of rules that look missing.
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
if (!gitOk) warn('.gitignore', 'git not installed; rules not checked');
else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ignore-'));
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(tmp, '.gitignore'));
  const emptyConfig = path.join(os.tmpdir(), path.basename(tmp) + '.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const gitEnv = Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' });
  Object.keys(gitEnv).forEach((k) => {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(k)) delete gitEnv[k];
  });
  const git = (args) => spawnSync('git', args, { cwd: tmp, env: gitEnv, encoding: 'utf8' });
  const firstLine = (r) => String(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0];
  let problem = null;
  const init = git(['init', '-q']);
  if (init.status !== 0) problem = 'git init failed: ' + firstLine(init);
  else if (String(git(['rev-parse', '--git-dir']).stdout).trim() !== '.git') problem = 'throwaway repository is not isolated';
  const mustIgnore = ['.env', '.env.local', '.env.production', 'local-assistant/.env.local-assistant', 'local-assistant/.state/telegram-offset.json', 'local-assistant/.state/google-token.json', '.clasprc.json', '.clasp.json', 'node_modules/x.js',
    'ITW Faculty Travel Details.xlsx', 'export.csv', 'client_secret_123.json', 'debug.log'];
  const mustKeep = ['.env.example', '.clasp.json.example', 'src/Config.js', 'src/appsscript.json', 'package.json',
    'README.md', 'PROJECT_STATUS.md', 'tools/doctor.js', 'test/adb-tests.js',
    'local-assistant/.env.local-assistant.example', 'local-assistant/src/worker.js'];
  const ignored = (p) => {
    if (problem) return null;
    const r = git(['check-ignore', '-q', '--no-index', p]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    problem = 'git check-ignore failed (exit ' + r.status + '): ' + firstLine(r);
    return null;
  };
  const notIgnored = mustIgnore.filter((p) => ignored(p) === false);
  const wronglyIgnored = mustKeep.filter((p) => ignored(p) === true);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(emptyConfig, { force: true });
  if (problem) warn('.gitignore', 'could not check the rules: ' + problem);
  else {
    if (notIgnored.length) fail('.gitignore', 'should ignore: ' + notIgnored.join(', '));
    if (wronglyIgnored.length) fail('.gitignore', 'wrongly ignores: ' + wronglyIgnored.join(', '));
    if (!notIgnored.length && !wronglyIgnored.length) ok('.gitignore', mustIgnore.length + ' sensitive paths ignored, ' + mustKeep.length + ' project files kept');
  }
}

// 7. Tracked sensitive files (only if this is a git repository)
const inRepo = gitOk && spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' }).status === 0;
if (!inRepo) warn('Git', 'not a git repository yet: nothing is tracked. After "git init", run this again');
else {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean);
  const bad = tracked.filter((f) => /(^|\/)\.env(\.|$)(?!example$)|\.clasprc\.json$|(^|\/)\.clasp\.json$|\.(pem|p12|key|xlsx|xls|csv)$|client_secret|credentials.*\.json$/.test(f) && !f.endsWith('.example'));
  if (bad.length) fail('Git', 'sensitive files are TRACKED (rotate any keys inside, then git rm --cached): ' + bad.join(', '));
  else ok('Git', tracked.length + ' tracked files, none sensitive');
}

// 8. Credential-shaped strings in project files (values are never printed)
const patterns = [['Telegram bot token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/], ['RapidAPI key', /\b[0-9a-z]{18,}msh[0-9a-z]{10,}\b/i],
  ['long hex key', /\b[0-9a-f]{40,}\b/i], ['assigned secret', /\b(KEY|TOKEN|SECRET)\s*[=:]\s*["']?[A-Za-z0-9_\-:]{20,}/]];
const skipDirs = new Set(['node_modules', '.git', '.state']); // .state: the local assistant's own git-ignored OAuth token
const hits = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skipDirs.has(name)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (st.size > 2e6 || /^\.env$|^\.env\.(?!example$)/.test(name)) continue; // a local .env may legitimately hold values
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [label, re] of patterns) { const m = line.match(re); if (m) hits.push(rel(p) + ':' + (i + 1) + ' looks like a ' + label + ' (' + m[0].length + ' chars, value hidden)'); }
    });
  }
})(ROOT);
if (hits.length) fail('Secrets scan', hits.join('; '));
else ok('Secrets scan', 'no credential-shaped strings in project files');

// 9. clasp binding
if (!fs.existsSync(path.join(ROOT, '.clasp.json'))) warn('.clasp.json', 'absent (fine). Needed only for clasp: copy .clasp.json.example and paste your Script ID');
else {
  try {
    const c = JSON.parse(read('.clasp.json'));
    if (c.rootDir !== 'src') fail('.clasp.json', 'rootDir must be "src"');
    else if (!c.scriptId || /PASTE|YOUR/i.test(c.scriptId)) fail('.clasp.json', 'scriptId is still the placeholder');
    else ok('.clasp.json', 'rootDir src, scriptId set');
  } catch (e) { fail('.clasp.json', 'not valid JSON'); }
}

// 10. Test suites, with real credential variables removed from the environment
const env = Object.assign({}, process.env);
registry.forEach((n) => delete env[n]);
// DOCTOR_SKIP_TESTS=1 lets a test run the doctor's other checks without the doctor re-running the tests.
const skipTests = process.env.DOCTOR_SKIP_TESTS === '1';
if (skipTests) warn('Tests', 'skipped (DOCTOR_SKIP_TESTS=1)');
for (const t of skipTests ? [] : ['test/run-tests.js', 'test/adb-tests.js', 'test/setup-tests.js', 'test/dashboard-tests.js', 'test/telegram-tests.js',
  'test/flight-sort-tests.js', 'test/flight-position-tests.js', 'test/cab-suggestions-tests.js', 'test/smart-dispatch-tests.js',
  'test/guest-view-tests.js', 'test/sheet-source-tests.js', 'test/engine-tests.js', 'test/tracker-control-tests.js', 'test/env-example-guard-tests.js', 'test/assistant-fallback-tests.js', 'test/import-guests-tests.js', 'local-assistant/test/assistant-tests.js']) {
  if (!fs.existsSync(path.join(ROOT, t))) continue;
  const r = spawnSync(process.execPath, [path.join(ROOT, t)], { cwd: ROOT, env, encoding: 'utf8' });
  const summary = (String(r.stdout).match(/(\d+) passed, (\d+) failed/) || [])[0] || 'no summary';
  if (r.status === 0) ok('Tests ' + t, summary); else fail('Tests ' + t, summary + (r.stderr ? ' | ' + String(r.stderr).split('\n')[0] : ''));
}

const icon = { ok: '✔', warn: '⚠', error: '✖' };
results.forEach(([l, a, m]) => console.log(icon[l] + ' ' + a + ': ' + m));
const errors = results.filter((r) => r[0] === 'error').length, warns = results.filter((r) => r[0] === 'warn').length;
console.log('\n' + (errors ? errors + ' error(s)' : 'No errors') + ', ' + warns + ' warning(s). No network calls were made.');
process.exit(errors ? 1 : 0);
