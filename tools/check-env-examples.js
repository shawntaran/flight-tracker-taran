#!/usr/bin/env node
'use strict';
// Pre-commit guard (.githooks/pre-commit): the .env*.example files are blank templates that git tracks, so a
// real key typed into one would be published by the next push. Refuses the commit when the STAGED version of
// any example file has a value for a sensitive setting, or contains anything shaped like a real credential,
// and refuses a real .env file (e.g. force-added with "git add -f"). Prints which line, never the value.
//   node tools/check-env-examples.js            check what is staged (what the hook runs)
//   node tools/check-env-examples.js --all      check the example files as they are on disk

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXAMPLE_RE = /(^|\/)\.env[^/]*\.example$/;
const REAL_ENV_RE = /(^|\/)\.env(\.[^/]*)?$/;          // .env, .env.engine, .env.local-assistant, ...
// Settings that must stay blank in a template: anything secret or specific to one deployment.
const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CLIENT_ID|CHAT_IDS?|SPREADSHEET_ID|SERVICE_ROLE|SUPABASE_URL)$/;
// Credential shapes, anywhere in the file (also in comments).
const SHAPES = [
  ['Telegram bot token', /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['Google OAuth client secret', /\bGOCSPX-[0-9A-Za-z_-]{10,}/],
  ['Google OAuth client id', /\b\d{6,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com\b/],
  ['Supabase key', /\bsb_(secret|publishable)_[0-9A-Za-z_-]{10,}/],
  ['JWT (e.g. a Supabase key)', /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\./],
  ['Supabase project URL', /\bhttps:\/\/[a-z0-9]{20}\.supabase\.co\b/],
  ['OpenAI-style key', /\bsk-[0-9A-Za-z_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{30,}/]
];

/** Pure: an example file's text -> [{line, what}]. Never includes the value. */
function findProblems(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && SENSITIVE_NAME.test(m[1])) {
      const v = m[2].replace(/^(['"])(.*)\1$/, '$2').replace(/(^|\s+)#.*$/, '').trim(); // "KEY=  # note" is blank
      if (v) out.push({ line, what: m[1] + ' has a value (templates keep it blank)' });
    }
    SHAPES.forEach(([what, re]) => { if (re.test(raw) && !out.some((p) => p.line === line)) out.push({ line, what: 'looks like a ' + what }); });
  });
  return out;
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/** -> [{file, line?, what}] for the staged files. */
function checkStaged() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const out = [];
  files.forEach((f) => {
    if (EXAMPLE_RE.test(f)) findProblems(git(['show', ':' + f])).forEach((p) => out.push(Object.assign({ file: f }, p)));
    else if (REAL_ENV_RE.test(f)) out.push({ file: f, what: 'a real settings file is being committed; it holds your keys and must stay git-ignored' });
  });
  return out;
}

function checkOnDisk(root) {
  const out = [];
  git(['ls-files', '-z']).split('\0').filter((f) => EXAMPLE_RE.test(f)).forEach((f) => {
    findProblems(fs.readFileSync(path.join(root, f), 'utf8')).forEach((p) => out.push(Object.assign({ file: f }, p)));
  });
  return out;
}

function main() {
  const all = process.argv.includes('--all');
  const problems = all ? checkOnDisk(git(['rev-parse', '--show-toplevel']).trim()) : checkStaged();
  if (!problems.length) return;
  console.error('\nCommit refused: real settings in a file git would publish.\n');
  problems.forEach((p) => console.error('  ' + p.file + (p.line ? ':' + p.line : '') + '  ' + p.what));
  console.error('\nPut real values only in the git-ignored files (.env.engine, local-assistant/.env.local-assistant).');
  console.error('Reset a template with:  git checkout HEAD -- <file>   (then  git add  it again)');
  console.error('If a key was ever pushed, rotate it. Never use GitHub\'s "allow secret" links.\n');
  process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('check-env-examples: ' + ((e && e.message) || e)); process.exitCode = 1; }
}

module.exports = { findProblems, EXAMPLE_RE, REAL_ENV_RE };
