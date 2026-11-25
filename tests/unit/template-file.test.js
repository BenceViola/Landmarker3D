// Template files (.template.json): saving, opening, and using another template.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplateFile, templateFileText, templateFileName, buildLandmarkFile, LandmarkFileError } from '../../js/landmark-file.js';
import { Session, EXAMPLE_TEMPLATE } from '../../js/session.js';
import { MESH, SMALL_TEMPLATE, hit } from '../fixtures.js';

const throwsMsg = (fn, re) => assert.throws(fn, (e) => e instanceof LandmarkFileError && re.test(e.message));

describe('template files', () => {
  test('saved as the bare template with "dimensions": 3, named after its ID, and read back unchanged', () => {
    const t = { ...structuredClone(EXAMPLE_TEMPLATE), curves: [{ id: 'C01', name: 'Arch', n_points: 5, path: 'geodesic', spacing: 'equal_arc_length', start: 'LM01', end: 'LM02' }] };
    delete t.dimensions;
    const text = templateFileText(t);
    const saved = JSON.parse(text);
    assert.equal(saved.format, undefined, 'no landmark-file wrapper');
    assert.equal(saved.dimensions, 3);
    assert.deepEqual(saved.landmarks, t.landmarks);
    assert.equal(templateFileName(t), 'cranium-basic.template.json');
    assert.equal(templateFileName({ id: 'my template/1' }), 'my_template_1.template.json');
    const back = parseTemplateFile(text, 'x.template.json');
    assert.deepEqual(back.template, { ...t, dimensions: 3 });
    assert.deepEqual(back.warnings, []);
    assert.equal(back.fromLandmarkFile, false);
  });

  test('a template written by the 2D app’s rules without "dimensions" counts as 3D; unknown fields are kept', () => {
    const t = { id: 'x', name: 'X', landmarks: [{ id: 'A', name: 'a' }], author: 'BV', extra: { k: 1 } };
    const r = parseTemplateFile(JSON.stringify(t), 'x.template.json');
    assert.equal(r.template.dimensions, 3);
    assert.deepEqual(r.template.extra, { k: 1 });
  });

  test('a landmark file can be opened as a template: its template is used', () => {
    const s = new Session(SMALL_TEMPLATE);
    s.place('LM01', hit(0, 0, 0));
    const { text } = buildLandmarkFile({ session: s, mesh: MESH, units: 'mm', specimenId: 'A' });
    const r = parseTemplateFile(text, 'A.lmk.json');
    assert.equal(r.fromLandmarkFile, true);
    assert.deepEqual(r.template.landmarks, SMALL_TEMPLATE.landmarks);
  });

  test('refused: 2D templates, references to other template files, files without a template', () => {
    throwsMsg(() => parseTemplateFile(JSON.stringify({ id: 'fish', name: 'Fish', dimensions: 2, landmarks: [] }), 'f.template.json'), /2D template/);
    throwsMsg(() => parseTemplateFile(JSON.stringify({ format: 'landmark-json', version: '0.2.0', template: { ref: 'skull.template.json' } }), 'a.lmk.json'), /refers to another template file/);
    throwsMsg(() => parseTemplateFile('{"hello": 1}', 'h.json'), /isn’t a template file/);
    throwsMsg(() => parseTemplateFile('not json', 'h.json'), /isn’t valid JSON/);
    throwsMsg(() => parseTemplateFile(JSON.stringify({ id: 'x', landmarks: [{ id: 'A' }, { id: 'A' }] }), 'x.template.json'), /missing or repeated ID/);
  });

  test('unusable planes and curve ends are tidied with a note, as for landmark files', () => {
    const t = { id: 'x', name: 'X', landmarks: [{ id: 'A', name: 'a' }], curves: [{ id: 'C01', name: 'c', start: 'ZZ' }] };
    const r = parseTemplateFile(JSON.stringify(t), 'x.template.json');
    assert.equal('start' in r.template.curves[0], false);
    assert.match(r.warnings.join(' '), /became free/);
  });
});

describe('using another template', () => {
  test('an empty set simply takes it', () => {
    const s = new Session(SMALL_TEMPLATE);
    const r = s.applyTemplate({ ...structuredClone(EXAMPLE_TEMPLATE), dimensions: undefined });
    assert.deepEqual(r, { orphaned: 0, removedCurves: 0 });
    assert.equal(s.template.id, 'cranium-basic');
    assert.equal(s.template.dimensions, 3);
    assert.equal(s.activeId, 'LM01');
  });

  test('points of landmarks it no longer lists become ad hoc points with their name; dropped curves go; one undo step brings everything back', () => {
    const s = new Session(SMALL_TEMPLATE); // LM01..LM03
    s.place('LM01', hit(0, 0, 0));
    s.place('LM02', hit(1, 0, 0));
    const c = s.addCurveDef('Arch');
    s.setActive(c);
    s.place(c, hit(2, 0, 0));
    const name2 = s.def('LM02').name;
    const before = structuredClone(s.template);

    const t = { id: 'new', name: 'New', landmarks: [{ id: 'LM01', name: 'First' }, { id: 'LM09', name: 'Other' }] };
    const r = s.applyTemplate(t);
    assert.deepEqual(r, { orphaned: 1, removedCurves: 1 });
    const p2 = s.points.find((p) => p.id === 'LM02');
    assert.equal(p2.template_id, null, 'kept as an ad hoc point');
    assert.equal(p2.label, name2);
    assert.equal(s.point('LM01').template_id, 'LM01');
    assert.deepEqual(s.current.curves, []);
    assert.equal(s.current.dirty, true);

    s.undo();
    assert.deepEqual(s.template, before);
    assert.equal(s.points.find((p) => p.id === 'LM02').template_id, 'LM02');
    assert.equal(s.curve(c).control_points.length, 1);
  });

  test('it applies to every specimen in the set', () => {
    const s = new Session(SMALL_TEMPLATE);
    s.place('LM03', hit(0, 0, 0));
    const a = s.current;
    const b = s.addRecord({ specimen: { id: 'B' } });
    s.switchTo(b.uid);
    s.place('LM03', hit(5, 0, 0));
    s.applyTemplate({ id: 'n', name: 'N', landmarks: [{ id: 'LM01', name: 'x' }] });
    for (const rec of [a, b]) assert.equal(rec.points.find((p) => p.id === 'LM03').template_id, null);
  });
});
