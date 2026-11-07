import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Session, ADHOC } from '../../js/session.js';
import { buildLandmarkFile, parseLandmarkFile } from '../../js/landmark-file.js';
import { tpsBlock, combineTps, adhocIdsOf } from '../../js/tps.js';
import { hit, MESH, SMALL_TEMPLATE } from '../fixtures.js';

// Reads TPS the way geomorph's readland.tps does: "LM3=n" opens a block of n
// coordinate rows; "ID=" names it; other KEY= lines are ignored.
function readTps(text) {
  const lines = text.split(/\r?\n/);
  const specimens = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^LM3=(\d+)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      const rows = lines.slice(i + 1, i + 1 + n).map((l) => l.trim().split(/\s+/).map(Number));
      for (const r of rows) assert.equal(r.length, 3, `3 numbers per row in "${line}" block`);
      for (const v of rows.flat()) assert.ok(Number.isFinite(v), 'every value is a number');
      cur = { n, rows, id: null };
      specimens.push(cur);
      i += n;
    } else if (line.startsWith('ID=')) {
      assert.ok(cur, 'ID= follows a block');
      cur.id = line.slice(3);
    } else {
      assert.match(line, /^[A-Z]+=/, `unexpected line "${line}"`);
    }
  }
  return specimens;
}

function specimen(id, { adhoc = 0, missing = [], skip = [] } = {}) {
  const s = new Session(SMALL_TEMPLATE);
  SMALL_TEMPLATE.landmarks.forEach((d, i) => {
    if (missing.includes(d.id)) s.markMissing(d.id);
    else if (!skip.includes(d.id)) s.place(d.id, hit(i + 1, (i + 1) * 10, (i + 1) * 100));
  });
  for (let k = 0; k < adhoc; k++) s.place(ADHOC, hit(9, 9, 9 + k));
  const text = buildLandmarkFile({ session: s, mesh: MESH, units: 'mm', specimenId: id }).text;
  return { session: s, parsed: parseLandmarkFile(text, `${id}.lmk.json`) };
}

describe('single specimen', () => {
  test('LM3 block with template rows and an ID line', () => {
    const { session } = specimen('SKULL_014');
    const { text, rows, notPlaced } = tpsBlock({ id: 'SKULL_014', template: session.template, points: session.points });
    assert.equal(text, 'LM3=3\n1 10 100\n2 20 200\n3 30 300\nID=SKULL_014\n');
    assert.equal(rows, 3);
    assert.equal(notPlaced, 0);
  });

  test('missing and never-placed landmarks use the missing value', () => {
    const { session } = specimen('A', { missing: ['LM02'], skip: ['LM03'] });
    const r = tpsBlock({ id: 'A', template: session.template, points: session.points });
    const [s] = readTps(r.text);
    assert.deepEqual(s.rows[1], [-999, -999, -999]);
    assert.deepEqual(s.rows[2], [-999, -999, -999]);
    assert.equal(r.notPlaced, 1, 'only the never-placed one counts as not placed');
  });

  test('the missing value is configurable', () => {
    const { session } = specimen('A', { missing: ['LM01'] });
    const r = tpsBlock({ id: 'A', template: session.template, points: session.points, missing: 'NA' });
    assert.match(r.text, /^LM3=3\nNA NA NA\n/);
  });

  test('estimated landmarks are written with their coordinates', () => {
    const { session } = specimen('A');
    session.toggleEstimated('LM02');
    assert.deepEqual(readTps(tpsBlock({ id: 'A', template: session.template, points: session.points }).text)[0].rows[1], [2, 20, 200]);
  });

  test('rows follow export_order, not the file order', () => {
    const { session } = specimen('A');
    session.template.export_order = ['LM03', 'LM01', 'LM02'];
    const [s] = readTps(tpsBlock({ id: 'A', template: session.template, points: session.points }).text);
    assert.deepEqual(s.rows.map((r) => r[0]), [3, 1, 2]);
  });

  test('ad hoc points only when asked, after the template rows', () => {
    const { session } = specimen('A', { adhoc: 2 });
    const without = readTps(tpsBlock({ id: 'A', template: session.template, points: session.points }).text)[0];
    assert.equal(without.n, 3);
    const ids = adhocIdsOf(session.points);
    assert.deepEqual(ids, ['AH01', 'AH02']);
    const withAdhoc = readTps(tpsBlock({ id: 'A', template: session.template, points: session.points, adhocIds: ids }).text)[0];
    assert.equal(withAdhoc.n, 5);
    assert.deepEqual(withAdhoc.rows[4], [9, 9, 10]);
  });

  test('numbers: at most 6 decimals, no exponent noise, negatives kept', () => {
    const s = new Session(SMALL_TEMPLATE);
    s.place('LM01', hit(0.1 + 0.2, -61.0874, 1.23456789));
    s.place('LM02', hit(1e-7, 123456.5, -0));
    s.place('LM03', hit(-0.0000004, 5, 5));
    const { text } = tpsBlock({ id: 'A', template: s.template, points: s.points });
    const lines = text.split('\n');
    assert.equal(lines[1], '0.3 -61.0874 1.234568');
    assert.equal(lines[2], '0 123456.5 0');
    assert.equal(lines[3], '0 5 5', 'tiny negatives round to 0, not -0');
  });
});

describe('combining files', () => {
  test('one block per specimen, sorted by specimen id', () => {
    const files = ['SK_10', 'SK_2', 'SK_1'].map((id) => specimen(id).parsed);
    const out = combineTps(files);
    const sp = readTps(out.text);
    assert.deepEqual(sp.map((s) => s.id), ['SK_1', 'SK_2', 'SK_10']);
    assert.ok(sp.every((s) => s.n === 3));
    assert.equal(out.count, 3);
    assert.deepEqual(out.notes, []);
  });

  test('different templates are refused', () => {
    const a = specimen('A').parsed;
    const b = specimen('B').parsed;
    b.template.id = 'other';
    assert.throws(() => combineTps([a, b]), /different template/);
  });

  test('same template id but different order is refused', () => {
    const a = specimen('A').parsed;
    const b = specimen('B').parsed;
    b.template.export_order = ['LM02', 'LM01', 'LM03'];
    assert.throws(() => combineTps([a, b]), /different template/);
  });

  test('ad hoc points are kept only if every file has the same ones', () => {
    const same = combineTps([specimen('A', { adhoc: 1 }).parsed, specimen('B', { adhoc: 1 }).parsed]);
    assert.ok(readTps(same.text).every((s) => s.n === 4));
    const differ = combineTps([specimen('A', { adhoc: 1 }).parsed, specimen('B').parsed]);
    assert.ok(readTps(differ.text).every((s) => s.n === 3));
    assert.match(differ.notes.join(' '), /Ad hoc points were left out/);
    const off = combineTps([specimen('A', { adhoc: 1 }).parsed], { includeAdhoc: false });
    assert.equal(readTps(off.text)[0].n, 3);
  });

  test('notes about never-placed landmarks and repeated specimen ids', () => {
    const out = combineTps([specimen('A', { skip: ['LM01'] }).parsed, specimen('A').parsed]);
    assert.match(out.notes.join(' '), /1 landmark was never placed/);
    assert.match(out.notes.join(' '), /used more than once: A/);
  });

  test('nothing chosen is an error', () => {
    assert.throws(() => combineTps([]), /No landmark files/);
  });
});
