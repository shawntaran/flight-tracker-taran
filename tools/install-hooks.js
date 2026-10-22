'use strict';
// Run by "npm install" (package.json "prepare"): points git at the repository's own hooks in .githooks/
// (the pre-commit check in tools/check-env-examples.js). Does nothing outside a git checkout; never fails the install.

const { execFileSync } = require('child_process');

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch (e) {
  // not a git checkout, or git missing: nothing to install
}
