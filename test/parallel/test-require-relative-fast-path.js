'use strict';
const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const tmpdir = require('../common/tmpdir');

if (!common.canCreateSymLink())
  common.skip('insufficient privileges');

tmpdir.refresh();
const dir = tmpdir.resolve('relative-fast-path');
fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
fs.mkdirSync(path.join(dir, 'dir.js'));
fs.mkdirSync(path.join(dir, 'realdir'));

fs.writeFileSync(path.join(dir, 'file.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(dir, 'target.js'), 'module.exports = 2;\n');
fs.writeFileSync(path.join(dir, 'extless'), 'module.exports = 3;\n');
fs.writeFileSync(path.join(dir, 'sub', 'nested.js'), 'module.exports = 4;\n');
fs.writeFileSync(path.join(dir, 'dir.js', 'index.js'), 'module.exports = 5;\n');
fs.writeFileSync(path.join(dir, 'realdir', 'in.js'), 'module.exports = 6;\n');
fs.writeFileSync(path.join(dir, 'plain.json'), '{"ok":true}\n');
fs.symlinkSync(path.join(dir, 'target.js'), path.join(dir, 'link.js'));
fs.symlinkSync(path.join(dir, 'realdir'), path.join(dir, 'linkdir'));

// createRequire does not realpath its argument. tmpdir often lives under a
// symlink (/var -> /private/var, /tmp -> /private/tmp), so this parent path
// is not real. Resolution must still return the real path.
const parent = path.join(dir, 'parent.js');
fs.writeFileSync(parent, '');
const req = createRequire(parent);

assert.strictEqual(req('./file.js'), 1);
assert.strictEqual(req('./file.js'), 1);
assert.strictEqual(
  req.resolve('./file.js'),
  fs.realpathSync(path.join(dir, 'file.js')),
);
assert.strictEqual(req('./link.js'), 2);
assert.strictEqual(
  req.resolve('./link.js'),
  fs.realpathSync(path.join(dir, 'target.js')),
);
assert.strictEqual(req('./extless'), 3);
assert.strictEqual(req('./sub/nested.js'), 4);
assert.strictEqual(
  req.resolve('./sub/nested.js'),
  fs.realpathSync(path.join(dir, 'sub', 'nested.js')),
);
assert.strictEqual(req('./dir.js'), 5);
assert.strictEqual(req('./linkdir/in.js'), 6);
assert.strictEqual(
  req.resolve('./linkdir/in.js'),
  fs.realpathSync(path.join(dir, 'realdir', 'in.js')),
);
assert.strictEqual(req('./plain.json').ok, true);

assert.throws(
  () => req('./missing.js'),
  { code: 'MODULE_NOT_FOUND' },
);
assert.throws(
  () => req.resolve('./file.js', { paths: [path.join(dir, 'sub')] }),
  { code: 'MODULE_NOT_FOUND' },
);
