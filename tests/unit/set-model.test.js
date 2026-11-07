import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  replicateOf, operatorOf, safeName, sameSpecimen, nextReplicate, exportIds, docFileName,
  templateDifference, progress, shuffledOrder, repeatability,
} from '../../js/set-model.js';
import { SMALL_TEMPLATE } from '../fixtures.js';

const st = (id, { rep, op, sha = 'aa', units = 'mm', points = [] } = {}) => ({
  specimen: { id, ...(rep ? { replicate: rep } : {}), mesh: { file: `${id}.stl`, sha256: sha, units } },
  template: SMALL_TEMPLATE,
  points,
  provenance: op ? { operator: op } : {},
});
const at = (id, position, status = 'placed') => ({ id, template_id: id, status, position });

describe('names and IDs', () => {
  test('replicate defaults to 1; odd values count as 1', () => {
    assert.equal(replicateOf(st('A')), 1);
    assert.equal(replicateOf(st('A', { rep: 3 })), 3);
    for (const bad of [0, -1, 1.5, '2', null]) assert.equal(replicateOf({ specimen: { replicate: bad } }), 1);
  });

  test('operator is trimmed; missing is empty', () => {
    assert.equal(operatorOf(st('A', { op: '  Ana ' })), 'Ana');
    assert.equal(operatorOf(st('A')), '');
  });

  test('safeName keeps letters, digits, - _ . and drops the rest', () => {
    assert.equal(safeName('  Ana María López '), 'Ana_Mar_a_L_pez');
    assert.equal(safeName('../x/y'), 'x_y');
    assert.equal(safeName(''), '');
  });

  test('file names: replicates after the first get _r<n>', () => {
    assert.equal(docFileName(st('SKULL 14')), 'SKULL_14.lmk.json');
    assert.equal(docFileName(st('SKULL_14', { rep: 2 })), 'SKULL_14_r2.lmk.json');
    assert.equal(docFileName(st('')), 'specimen.lmk.json');
  });

  test('export IDs: plain when unambiguous', () => {
    assert.deepEqual(exportIds([st('A'), st('B')]), ['A', 'B']);
  });

  test('export IDs: every ID gets _r<n> once any specimen has replicates', () => {
    assert.deepEqual(exportIds([st('A'), st('A', { rep: 2 }), st('B')]), ['A_r1', 'A_r2', 'B_r1']);
  });

  test('export IDs: every ID gets the operator once a specimen has several operators', () => {
    assert.deepEqual(
      exportIds([st('A', { op: 'ana' }), st('A', { op: 'Ben K' }), st('B', { op: 'ana' }), st('C')]),
      ['A_ana', 'A_Ben_K', 'B_ana', 'C_unknown']
    );
  });

  test('export IDs: operator and replicate together', () => {
    assert.deepEqual(
      exportIds([st('A', { op: 'ana' }), st('A', { op: 'ana', rep: 2 }), st('A', { op: 'ben' })]),
      ['A_ana_r1', 'A_ana_r2', 'A_ben_r1']
    );
  });
});

describe('replicates', () => {
  test('same specimen means same ID and same mesh file', () => {
    assert.equal(sameSpecimen(st('A'), st('A', { rep: 2 })), true);
    assert.equal(sameSpecimen(st('A'), st('A', { sha: 'bb' })), false);
    assert.equal(sameSpecimen(st('A', { sha: 'AA' }), st('A', { sha: 'aa' })), true, 'hash case does not matter');
    assert.equal(sameSpecimen(st('A'), st('B')), false);
  });

  test('next replicate number', () => {
    const set = [st('A'), st('A', { rep: 3 }), st('B')];
    assert.equal(nextReplicate(set, set[0]), 4);
    assert.equal(nextReplicate(set, set[2]), 2);
    assert.equal(nextReplicate([], st('C')), 1);
  });

  test('shuffled order is a permutation of the template ids', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const order = shuffledOrder(SMALL_TEMPLATE, rand);
    assert.deepEqual([...order].sort(), ['LM01', 'LM02', 'LM03']);
  });

  test('repeatability: distances between replicates, per landmark', () => {
    const r = repeatability([
      st('A', { points: [at('LM01', [0, 0, 0]), at('LM02', [10, 0, 0])] }),
      st('A', { rep: 2, points: [at('LM01', [3, 4, 0]), at('LM02', [10, 0, 1])] }),
      st('B', { points: [at('LM01', [5, 5, 5])] }), // no replicate: ignored
    ]);
    assert.equal(r.units, 'mm');
    assert.deepEqual(r.specimens, [{ id: 'A', replicates: 2 }]);
    const lm1 = r.rows.find((x) => x.id === 'LM01');
    const lm2 = r.rows.find((x) => x.id === 'LM02');
    assert.equal(lm1.mean, 5);
    assert.equal(lm1.specimens, 1);
    assert.equal(lm2.mean, 1);
    assert.equal(r.rows.find((x) => x.id === 'LM03').pairs, 0, 'not placed twice');
  });

  test('repeatability: three replicates give three pairs; missing points are left out', () => {
    const r = repeatability([
      st('A', { points: [at('LM01', [0, 0, 0])] }),
      st('A', { rep: 2, points: [at('LM01', [1, 0, 0])] }),
      st('A', { rep: 3, points: [at('LM01', [2, 0, 0]), at('LM02', null, 'missing')] }),
    ]);
    const lm1 = r.rows.find((x) => x.id === 'LM01');
    assert.equal(lm1.pairs, 3);
    assert.equal(lm1.max, 2);
    assert.ok(Math.abs(lm1.mean - 4 / 3) < 1e-12);
    assert.equal(r.rows.find((x) => x.id === 'LM02').pairs, 0);
  });

  test('repeatability: flags landmarks far above the typical spread', () => {
    const make = (rep, d3) => st('A', { rep, points: [at('LM01', [0, 0, rep * 0.1]), at('LM02', [5, 0, rep * 0.1]), at('LM03', [9, 0, rep * d3])] });
    const r = repeatability([make(1, 1), make(2, 1)]);
    assert.deepEqual(r.rows.map((x) => x.flag), [false, false, true]);
  });

  test('repeatability: mixed or unknown units are reported as mesh units', () => {
    const r = repeatability([st('A', { units: 'mm', points: [at('LM01', [0, 0, 0])] }), st('A', { rep: 2, units: 'unknown', points: [at('LM01', [1, 0, 0])] })]);
    assert.equal(r.units, 'mesh units');
  });

  test('repeatability: nothing replicated', () => {
    const r = repeatability([st('A')]);
    assert.deepEqual(r.specimens, []);
    assert.equal(r.median, null);
  });
});

describe('templates and progress', () => {
  test('same template id and landmarks: no difference', () => {
    assert.equal(templateDifference(SMALL_TEMPLATE, structuredClone(SMALL_TEMPLATE)), null);
  });

  test('renamed landmarks or new descriptions do not matter', () => {
    const b = structuredClone(SMALL_TEMPLATE);
    b.landmarks[0].name = 'Something else';
    b.landmarks[0].description = 'Here';
    assert.equal(templateDifference(SMALL_TEMPLATE, b), null);
  });

  test('a different id, landmark list or order is a difference', () => {
    assert.match(templateDifference(SMALL_TEMPLATE, { ...SMALL_TEMPLATE, id: 'other' }), /uses the template “other”/);
    const fewer = { ...SMALL_TEMPLATE, landmarks: SMALL_TEMPLATE.landmarks.slice(1) };
    assert.match(templateDifference(SMALL_TEMPLATE, fewer), /different landmarks/);
    const order = { ...SMALL_TEMPLATE, export_order: ['LM03', 'LM02', 'LM01'] };
    assert.match(templateDifference(SMALL_TEMPLATE, order), /different order/);
  });

  test('progress counts placed, estimated and missing; not ad hoc', () => {
    const p = progress(st('A', { points: [at('LM01', [0, 0, 0]), at('LM02', null, 'missing'), { id: 'AH01', template_id: null, status: 'placed', position: [1, 1, 1] }] }));
    assert.deepEqual(p, { done: 2, total: 3 });
  });
});
