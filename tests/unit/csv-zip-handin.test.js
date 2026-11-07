import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { Session, ADHOC } from '../../js/session.js';
import { buildLandmarkFile } from '../../js/landmark-file.js';
import { toCsv, CSV_HEADER } from '../../js/csv.js';
import { zipFiles, unzipFiles, crc32 } from '../../js/zip.js';
import { handInFiles, readEntries, combineEntries, stateOf } from '../../js/handin.js';
import { parseLandmarkFile } from '../../js/landmark-file.js';
import { hit, MESH, SMALL_TEMPLATE } from '../fixtures.js';

// A built landmark file for a specimen with all three landmarks placed.
function doc(id, { operator = '', replicate = 1, skip = [], template = SMALL_TEMPLATE, adhoc = 0, sha = MESH.sha256 } = {}) {
  const s = new Session(template);
  template.landmarks.forEach((d, i) => { if (!skip.includes(d.id)) s.place(d.id, hit(i + 1, 2 * (i + 1), 3 * (i + 1))); });
  for (let k = 0; k < adhoc; k++) s.place(ADHOC, hit(7, 8, 9));
  return buildLandmarkFile({ session: s, mesh: { ...MESH, name: `${id}.ply`, sha256: sha }, units: 'mm', specimenId: id, operator, replicate });
}
const file = (name, data) => ({ name, async arrayBuffer() { return typeof data === 'string' ? new TextEncoder().encode(data).buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); } });
const parseCsv = (text) => text.trim().split('\n').map((l) => l.split(','));

describe('CSV', () => {
  test('header and one row per template landmark, with z and units', () => {
    const st = stateOf(parseLandmarkFile(doc('SK_1', { operator: 'ana' }).text, 'a'));
    const rows = parseCsv(toCsv([st]));
    assert.equal(rows[0].join(','), CSV_HEADER);
    assert.equal(rows.length, 4);
    const col = Object.fromEntries(rows[0].map((h, i) => [h, i]));
    const r = rows[1];
    assert.equal(r[col.tps_id], 'SK_1');
    assert.equal(r[col.specimen_id], 'SK_1');
    assert.equal(r[col.replicate], '1');
    assert.equal(r[col.operator], 'ana');
    assert.equal(r[col.mesh], 'SK_1.ply');
    assert.equal(r[col.point], 'LM01');
    assert.equal(r[col.label], 'Nasion');
    assert.equal(r[col.type], 'landmark');
    assert.deepEqual([r[col.x], r[col.y], r[col.z]], ['1', '2', '3']);
    assert.equal(r[col.units], 'mm');
    assert.equal(r[col.status], 'placed');
  });

  test('not placed and missing landmarks have NA coordinates and say why', () => {
    const s = new Session(SMALL_TEMPLATE);
    s.place('LM01', hit(1));
    s.markMissing('LM02');
    const st = { specimen: { id: 'A', mesh: { file: 'a.stl', units: 'mm' } }, template: s.template, points: s.points, provenance: {} };
    const rows = parseCsv(toCsv([st]));
    assert.deepEqual(rows[2].slice(11), ['NA', 'NA', 'NA', 'mm', 'missing']);
    assert.deepEqual(rows[3].slice(11), ['NA', 'NA', 'NA', 'mm', 'not_done']);
  });

  test('ad hoc points come last, labelled adhoc', () => {
    const st = stateOf(parseLandmarkFile(doc('A', { adhoc: 2 }).text, 'a'));
    const rows = parseCsv(toCsv([st]));
    assert.deepEqual(rows.slice(-2).map((r) => [r[5], r[8]]), [['AH01', 'adhoc'], ['AH02', 'adhoc']]);
  });

  test('texts with commas or quotes are quoted', () => {
    const t = structuredClone(SMALL_TEMPLATE);
    t.landmarks[0].name = 'Zygion, "left"';
    const st = { specimen: { id: 'A', mesh: { file: 'a.stl', units: 'mm' } }, template: t, points: [], provenance: {} };
    assert.match(toCsv([st]), /"Zygion, ""left"""/);
  });

  test('specimen and replicate are separate columns, tps_id carries both', () => {
    const states = [doc('A'), doc('A', { replicate: 2 })].map((d) => stateOf(parseLandmarkFile(d.text, 'x')));
    const rows = parseCsv(toCsv(states, { ids: ['A_r1', 'A_r2'] }));
    assert.deepEqual(rows.slice(1).map((r) => [r[0], r[1], r[2]]).filter((_, i) => i % 3 === 0), [['A_r1', 'A', '1'], ['A_r2', 'A', '2']]);
  });
});

describe('zip', () => {
  test('crc32 matches the standard check value', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  });

  test('round trip, including non-ASCII names', async () => {
    const files = [{ name: 'a.lmk.json', data: '{"x": 1}\n' }, { name: 'Müller_landmarks.csv', data: 'a,b\n1,2\n' }];
    const back = await unzipFiles(zipFiles(files));
    assert.deepEqual(back.map((f) => [f.name, new TextDecoder().decode(f.data)]), files.map((f) => [f.name, f.data]));
  });

  test('the system unzip tool reads our zips', (t) => {
    let has = true;
    try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { has = false; }
    if (!has) return t.skip('unzip not installed');
    const dir = mkdtempSync(join(tmpdir(), 'lmk-zip-'));
    writeFileSync(join(dir, 'h.zip'), zipFiles([{ name: 'x/a.txt', data: 'hello' }]));
    execFileSync('unzip', ['-q', join(dir, 'h.zip'), '-d', join(dir, 'out')]);
    assert.equal(readFileSync(join(dir, 'out/x/a.txt'), 'utf8'), 'hello');
    assert.match(execFileSync('unzip', ['-t', join(dir, 'h.zip')]).toString(), /No errors/);
  });

  test('reads compressed entries and skips folders and macOS metadata', async () => {
    // Build a zip with one deflated entry by patching a stored one.
    const text = '{"format":"landmark-json"}'.repeat(20);
    const packed = deflateRawSync(Buffer.from(text));
    const stored = zipFiles([{ name: 'a.json', data: packed }, { name: '__MACOSX/._a.json', data: 'x' }, { name: 'dir/', data: '' }]);
    const v = new DataView(stored.buffer);
    // local header: method at 8, crc at 14, sizes at 18 (compressed) and 22 (real)
    v.setUint16(8, 8, true);
    v.setUint32(14, crc32(new TextEncoder().encode(text)), true);
    v.setUint32(22, text.length, true);
    // central header of the first entry
    const cen = stored.length - 22 - (46 * 3 + 'a.json'.length + '__MACOSX/._a.json'.length + 'dir/'.length);
    v.setUint16(cen + 10, 8, true);
    v.setUint32(cen + 24, text.length, true);
    const out = await unzipFiles(stored);
    assert.deepEqual(out.map((f) => f.name), ['a.json']);
    assert.equal(new TextDecoder().decode(out[0].data), text);
  });

  test('not a zip', async () => {
    await assert.rejects(unzipFiles(new TextEncoder().encode('hello')), /not a zip file/);
  });
});

describe('hand-in', () => {
  test('one file per specimen, replicates named _r<n>, plus TPS and CSV named after the student', () => {
    const { files } = handInFiles([doc('A', { operator: 'Ana M' }), doc('A', { operator: 'Ana M', replicate: 2 }), doc('B', { operator: 'Ana M' })], { operator: 'Ana M' });
    assert.deepEqual(files.map((f) => f.name), ['A.lmk.json', 'A_r2.lmk.json', 'B.lmk.json', 'Ana_M_landmarks.tps', 'Ana_M_landmarks.csv']);
    const tps = files[3].data;
    assert.deepEqual(tps.split('\n').filter((l) => l.startsWith('ID=')), ['ID=A_r1', 'ID=A_r2', 'ID=B_r1']);
  });

  test('two specimens with the same file name get distinct names', () => {
    const { files } = handInFiles([doc('A'), doc('A', { sha: 'cd'.repeat(32) })]);
    assert.deepEqual(files.slice(0, 2).map((f) => f.name), ['A.lmk.json', 'A_2.lmk.json']);
    assert.equal(files[2].name, 'landmarks_landmarks.tps');
  });

  test('a hand-in zip opens again with every specimen', async () => {
    const { files } = handInFiles([doc('A', { operator: 'ana' }), doc('B', { operator: 'ana' })], { operator: 'ana' });
    const entries = await readEntries([file('ana_landmarks.zip', zipFiles(files))]);
    assert.deepEqual(entries.map((e) => e.name), ['A.lmk.json', 'B.lmk.json']);
    assert.ok(entries.every((e) => parseLandmarkFile(e.text, e.name)));
  });
});

describe('combining hand-ins', () => {
  test('several students: shared specimens get the operator in their ID', () => {
    const r = combineEntries([
      { source: 'ana.zip', name: 'A.lmk.json', text: doc('A', { operator: 'ana' }).text },
      { source: 'ana.zip', name: 'B.lmk.json', text: doc('B', { operator: 'ana', skip: ['LM03'] }).text },
      { source: 'ben.zip', name: 'A.lmk.json', text: doc('A', { operator: 'ben' }).text },
    ]);
    assert.equal(r.states.length, 3);
    assert.deepEqual(r.ids, ['A_ana', 'A_ben', 'B_ana']);
    assert.deepEqual(r.operators, [{ operator: 'ana', specimens: 2, complete: 1 }, { operator: 'ben', specimens: 1, complete: 1 }]);
    assert.deepEqual(r.shared, [{ id: 'A', operators: 2 }]);
  });

  test('different templates are refused, exact repeats skipped', () => {
    const other = { ...SMALL_TEMPLATE, id: 'other' };
    const r = combineEntries([
      { source: 'a.zip', name: 'A.lmk.json', text: doc('A', { operator: 'ana' }).text },
      { source: 'b.zip', name: 'B.lmk.json', text: doc('B', { operator: 'ben', template: other }).text },
      { source: 'a2.zip', name: 'A.lmk.json', text: doc('A', { operator: 'ana' }).text },
    ]);
    assert.equal(r.states.length, 1);
    assert.match(r.refused[0].reason, /not combined: it uses the template “other”/);
    assert.match(r.skipped[0].reason, /Same specimen, operator and replicate/);
  });

  test('unreadable entries are refused with the reason', () => {
    const r = combineEntries([
      { source: 'x.zip', name: 'x.zip', error: '“x.zip”: The zip file is damaged.' },
      { source: 'y.json', name: 'y.json', text: '{nope' },
    ]);
    assert.equal(r.states.length, 0);
    assert.match(r.refused[0].reason, /damaged/);
    assert.match(r.refused[1].reason, /isn’t valid JSON/);
  });

  test('replicates from one student keep _r<n>', () => {
    const r = combineEntries([
      { source: 'a', name: 'A_r2.lmk.json', text: doc('A', { operator: 'ana', replicate: 2 }).text },
      { source: 'a', name: 'A.lmk.json', text: doc('A', { operator: 'ana' }).text },
    ]);
    assert.deepEqual(r.ids, ['A_r1', 'A_r2'], 'sorted by replicate');
  });

  test('zips and loose files can be mixed; a zip without landmark files is reported', async () => {
    const zip = zipFiles(handInFiles([doc('A', { operator: 'ana' })], { operator: 'ana' }).files);
    const entries = await readEntries([
      file('ana.zip', zip),
      file('B.lmk.json', doc('B', { operator: 'ben' }).text),
      file('empty.zip', zipFiles([{ name: 'notes.txt', data: 'hi' }])),
      file('bad.zip', 'not a zip'),
    ]);
    const r = combineEntries(entries);
    assert.equal(r.states.length, 2);
    assert.deepEqual(r.refused.map((x) => x.source), ['empty.zip', 'bad.zip']);
  });
});
