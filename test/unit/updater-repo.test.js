'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { repoSlug } = require('../../src/updater.js');
test('package.json repository → owner/name for the GitHub updater (the "github:" form broke every auto-update before 0.16.2)', () => {
  assert.equal(repoSlug('github:jeffman44/cobander'), 'jeffman44/cobander');
  assert.equal(repoSlug('https://github.com/jeffman44/cobander.git'), 'jeffman44/cobander');
  assert.equal(repoSlug({ type: 'git', url: 'git+https://github.com/jeffman44/cobander.git' }), 'jeffman44/cobander');
  assert.equal(repoSlug('git@github.com:jeffman44/cobander.git'), 'jeffman44/cobander');
  assert.equal(repoSlug(''), null); assert.equal(repoSlug('nonsense'), null); assert.equal(repoSlug(undefined), null);
  assert.equal(repoSlug(require('../../package.json').repository), 'jeffman44/cobander', 'the real package.json resolves');
});
