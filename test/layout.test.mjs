import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, machineRoom, beltSpeed, loopPath } from '../src/world/layout.mjs';
import * as G from '../src/gfx/geom.mjs';

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const mode of ['full', 'compact']) {
  for (const keys of [[], ['fable'], ['fable', 'opus', 'sonnet', 'haiku'], ['fable', 'opus', 'sonnet', 'haiku', 'nova'], ['a', 'b', 'c', 'd', 'e', 'f', 'g']]) {
    test(`${mode} layout with ${keys.length} machines is consistent`, () => {
      const L = computeLayout(mode, keys);
      assert.equal(L.w, mode === 'full' ? 480 : 240);
      const n = keys.length || 4;
      assert.equal(L.rooms.filter((r) => r.kind === 'machine').length, n);
      for (const kind of ['control', 'lounge', 'dock', 'power', 'reactor']) assert.ok(L.byId[kind], kind);
      for (const r of L.rooms) {
        assert.ok(r.x >= 0 && r.y >= L.surface.h && r.x + r.w <= L.w && r.y + r.h <= L.h, `${r.id} in bounds`);
        assert.equal(r.floorY, r.y + r.h - G.FLOOR_T);
        if (r.kind !== 'reactor') assert.ok(!overlap(r, L.shaft), `${r.id} clear of the shaft`);
      }
      for (let i = 0; i < L.rooms.length; i++) for (let j = i + 1; j < L.rooms.length; j++) assert.ok(!overlap(L.rooms[i], L.rooms[j]), `${L.rooms[i].id} / ${L.rooms[j].id}`);
      // every non-reactor room sits on an elevator row, at that row's floor line
      for (const row of L.rows) {
        for (const r of [...row.left, ...row.right]) { assert.equal(r.row, row.index); assert.equal(r.floorY, row.floorY); }
        // the nearest room on each side touches the shaft and has a doorway toward it
        if (row.left[0]) { assert.equal(row.left[0].x + row.left[0].w, L.shaft.x); assert.ok(row.left[0].doorR); }
        if (row.right[0]) { assert.equal(row.right[0].x, L.shaft.x + L.shaft.w); assert.ok(row.right[0].doorL); }
      }
      assert.equal(L.shaft.y + L.shaft.h, L.reactor.y, 'shaft ends at the reactor hall ceiling');
      assert.equal(L.reactor.h, G.REACTOR_H);
    });
  }
}

test('layout key changes with mode and machines', () => {
  assert.notEqual(computeLayout('full', ['fable']).key, computeLayout('compact', ['fable']).key);
  assert.notEqual(computeLayout('full', ['fable']).key, computeLayout('full', ['fable', 'opus']).key);
  assert.equal(computeLayout('full', ['fable']).key, computeLayout('full', ['fable']).key);
});

test('machineRoom, beltSpeed, loopPath', () => {
  const L = computeLayout('full', ['fable', 'opus']);
  const rm = machineRoom(L, 'opus');
  assert.equal(rm.modelKey, 'opus');
  assert.equal(machineRoom(L, 'nope'), null);
  assert.equal(beltSpeed({ powered: false, speed: 1 }), 0);
  assert.ok(beltSpeed({ powered: true, speed: 1 }) > beltSpeed({ powered: true, speed: 0 }));
  const path = loopPath(rm);
  for (const [x, y] of path) assert.ok(x >= rm.x && x <= rm.x + rm.w && y >= rm.y && y <= rm.y + rm.h);
  for (let i = 1; i < path.length; i++) assert.ok(path[i][0] === path[i - 1][0] || path[i][1] === path[i - 1][1], 'axis-aligned');
});
