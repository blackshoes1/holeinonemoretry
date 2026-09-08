const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('actual grassMap creates deterministic bounded textures with mipmaps and capped filtering', () => {
  const source = fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8');
  const start = source.indexOf('function grassMap(');
  const end = source.indexOf('\n// 지면:', start);
  assert.ok(start >= 0 && end > start);
  class DataTexture {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
      this.repeat = { set: (x, y) => { this.repeats = [x, y]; } };
    }
  }
  const context = vm.createContext({ Uint8Array, THREE: {
    DataTexture, RGBAFormat: 'rgba', RepeatWrapping: 'repeat', SRGBColorSpace: 'srgb',
    LinearMipmapLinearFilter: 'mipmap', LinearFilter: 'linear',
  }, renderer: { capabilities: { getMaxAnisotropy: () => 16 } } });
  vm.runInContext('Math.random = () => { throw Error("global RNG consumed by grass data"); };', context);
  vm.runInContext(source.slice(start, end), context);
  for (const args of [[900, 900, 20, 0], [28, 370, 7, 22], [32, 32, 5, 8]]) {
    const t = context.grassMap(...args), duplicate = context.grassMap(...args);
    assert.deepEqual(t.data, duplicate.data);
    assert.equal(t.data.length, 128 * 128 * 4);
    assert.deepEqual(t.repeats, [args[0] / 16, args[1] / 16]);
    assert.equal(t.generateMipmaps, true);
    assert.equal(t.minFilter, 'mipmap');
    assert.equal(t.magFilter, 'linear');
    assert.equal(t.colorSpace, 'srgb');
    assert.equal(t.wrapS, 'repeat');
    assert.equal(t.wrapT, 'repeat');
    assert.equal(t.anisotropy, 4);
    for (let i = 0; i < t.data.length; i += 4) {
      assert.ok(t.data[i] >= 255 - args[2] - args[3]);
      assert.equal(t.data[i], t.data[i + 1]);
      assert.equal(t.data[i], t.data[i + 2]);
      assert.equal(t.data[i + 3], 255);
    }
  }
  context.renderer.capabilities.getMaxAnisotropy = () => 1;
  assert.equal(context.grassMap(16, 16, 5).anisotropy, 1);
});
