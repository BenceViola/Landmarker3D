import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Session, ADHOC, EXAMPLE_TEMPLATE, checkTemplate, DIMENSIONS, FORMAT, newRecord, replicateOf } from '../../js/session.js';
import { hit, SMALL_TEMPLATE } from '../fixtures.js';

const fresh = () => new Session(SMALL_TEMPLATE);
const changes = (s) => {
  const kinds = [];
  s.addEventListener('change', (e) => kinds.push(e.detail.kind));
  return kinds;
};

describe('template check (spec v0.2 dimensions)', () => {
  test('accepts 3D templates and templates without dimensions', () => {
    assert.equal(checkTemplate(SMALL_TEMPLATE), null);
    const { dimensions, ...noDims } = SMALL_TEMPLATE;
    assert.equal(checkTemplate(noDims), null);
  });

  test('refuses 2D templates, odd dimensions and missing landmark lists', () => {
    assert.match(checkTemplate({ ...SMALL_TEMPLATE, dimensions: 2 }), /2D template/);
    assert.match(checkTemplate({ ...SMALL_TEMPLATE, dimensions: 4 }), /must be 2 or 3/);
    assert.match(checkTemplate({ id: 'x', dimensions: 3 }), /no "landmarks"/);
  });

  test('constructor refuses a 2D template and stamps dimensions 3', () => {
    assert.throws(() => new Session({ ...SMALL_TEMPLATE, dimensions: 2 }), /2D template/);
    const { dimensions, ...noDims } = SMALL_TEMPLATE;
    assert.equal(new Session(noDims).template.dimensions, DIMENSIONS);
    assert.equal(FORMAT.version, '0.2.0');
  });

  test('constructor copies the template instead of sharing it', () => {
    const s = fresh();
    s.updateDef('LM01', { name: 'Changed' });
    assert.equal(SMALL_TEMPLATE.landmarks[0].name, 'Nasion');
  });

  test('example template is valid and has symmetric pairs', () => {
    assert.equal(checkTemplate(EXAMPLE_TEMPLATE), null);
    const byId = new Map(EXAMPLE_TEMPLATE.landmarks.map((d) => [d.id, d]));
    assert.equal(byId.size, EXAMPLE_TEMPLATE.landmarks.length, 'ids are unique');
    for (const d of EXAMPLE_TEMPLATE.landmarks) {
      if (d.bilateral_pair) assert.equal(byId.get(d.bilateral_pair)?.bilateral_pair, d.id, `${d.id} pair`);
    }
  });
});

describe('placing landmarks', () => {
  test('starts on the first landmark, all to do', () => {
    const s = fresh();
    assert.equal(s.activeId, 'LM01');
    assert.deepEqual(s.counts(), { total: 3, placed: 0, estimated: 0, missing: 0, todo: 3, adhoc: 0 });
  });

  test('placing stores the hit and moves to the next to-do', () => {
    const s = fresh();
    const id = s.place('LM01', hit(1, 2, 3, 7));
    assert.equal(id, 'LM01');
    const p = s.point('LM01');
    assert.deepEqual(p.position, [1, 2, 3]);
    assert.deepEqual(p.anchor, { face: 7, bary: [0.2, 0.3, 0.5] });
    assert.equal(p.template_id, 'LM01');
    assert.equal(p.status, 'placed');
    assert.match(p.placed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(s.activeId, 'LM02');
  });

  test('next to-do skips done landmarks and wraps round', () => {
    const s = fresh();
    s.place('LM02', hit(1));
    assert.equal(s.activeId, 'LM03');
    s.place('LM03', hit(2));
    assert.equal(s.activeId, 'LM01', 'wraps to the first one still to do');
    s.place('LM01', hit(3));
    assert.equal(s.activeId, null, 'nothing left');
  });

  test('re-placing a landmark updates it rather than adding a second point', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.place('LM01', hit(5));
    assert.equal(s.points.length, 1);
    assert.deepEqual(s.point('LM01').position, [5, 0, 0]);
  });

  test('placing a missing landmark makes it placed again', () => {
    const s = fresh();
    s.markMissing('LM01');
    s.place('LM01', hit(1));
    assert.equal(s.stateOf('LM01'), 'placed');
  });

  test('place does nothing without a landmark or a hit', () => {
    const s = fresh();
    assert.equal(s.place(null, hit(1)), null);
    assert.equal(s.place('LM01', null), null);
    assert.equal(s.points.length, 0);
    assert.equal(s.canUndo, false);
  });

  test('ad hoc points get AH ids, no template id, and do not take a template slot', () => {
    const s = fresh();
    s.setActive(ADHOC);
    assert.equal(s.place(ADHOC, hit(1)), 'AH01');
    assert.equal(s.place(ADHOC, hit(2)), 'AH02');
    const p = s.point('AH01');
    assert.equal(p.template_id, null);
    assert.equal(p.label, 'Ad hoc 1');
    assert.equal(s.counts().adhoc, 2);
    assert.equal(s.counts().todo, 3);
    assert.equal(s.activeId, 'LM01', 'goes back to the first to-do');
  });

  test('ad hoc numbering continues after deletions', () => {
    const s = fresh();
    s.place(ADHOC, hit(1));
    s.place(ADHOC, hit(2));
    s.clear('AH01');
    assert.equal(s.place(ADHOC, hit(3)), 'AH03');
  });

  test('rows list template landmarks in order, then ad hoc points', () => {
    const s = fresh();
    s.place(ADHOC, hit(1));
    s.place('LM02', hit(2));
    assert.deepEqual(s.rows().map((r) => r.id), ['LM01', 'LM02', 'LM03', 'AH01']);
    assert.deepEqual(s.rows().map((r) => r.order), [1, 2, 3, null]);
  });

  test('step moves the selection through the list and wraps', () => {
    const s = fresh();
    s.step(1);
    assert.equal(s.activeId, 'LM02');
    s.step(-1);
    s.step(-1);
    assert.equal(s.activeId, 'LM03');
    s.setActive(null);
    s.step(1);
    assert.equal(s.activeId, 'LM01');
  });
});

describe('statuses', () => {
  test('missing clears position, anchor and normal and moves on', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.setActive('LM01');
    s.markMissing('LM01');
    const p = s.point('LM01');
    assert.equal(p.status, 'missing');
    assert.equal(p.position, null);
    assert.equal(p.anchor, undefined);
    assert.equal(p.normal, undefined);
    assert.equal(s.activeId, 'LM02');
  });

  test('missing can be set on a landmark that was never placed', () => {
    const s = fresh();
    s.markMissing('LM03');
    assert.equal(s.stateOf('LM03'), 'missing');
    assert.equal(s.counts().missing, 1);
  });

  test('ad hoc points cannot be marked missing', () => {
    const s = fresh();
    s.markMissing(ADHOC);
    assert.equal(s.points.length, 0);
  });

  test('estimated toggles only on points with a position', () => {
    const s = fresh();
    s.toggleEstimated('LM01');
    assert.equal(s.stateOf('LM01'), 'todo', 'nothing to toggle');
    s.place('LM01', hit(1));
    s.toggleEstimated('LM01');
    assert.equal(s.stateOf('LM01'), 'estimated');
    s.toggleEstimated('LM01');
    assert.equal(s.stateOf('LM01'), 'placed');
    s.markMissing('LM02');
    s.toggleEstimated('LM02');
    assert.equal(s.stateOf('LM02'), 'missing');
  });

  test('clearing a template landmark makes it to-do; clearing ad hoc deletes it', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.place(ADHOC, hit(2));
    s.clear('LM01');
    assert.equal(s.stateOf('LM01'), 'todo');
    assert.equal(s.activeId, 'LM01');
    s.clear('AH01');
    assert.equal(s.point('AH01'), null);
  });

  test('notes are trimmed, and an empty note removes the field', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.setNote('LM01', '  broken  ');
    assert.equal(s.point('LM01').note, 'broken');
    s.setNote('LM01', '   ');
    assert.equal('note' in s.point('LM01'), false);
  });

  test('labelOf prefers the point label, then the template name', () => {
    const s = fresh();
    assert.equal(s.labelOf('LM01'), 'Nasion');
    assert.equal(s.labelOf(ADHOC), 'Ad hoc point');
    s.place(ADHOC, hit(1));
    assert.equal(s.labelOf('AH01'), 'Ad hoc 1');
  });
});

describe('undo and redo', () => {
  test('undo and redo walk back and forward through edits', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.place('LM02', hit(2));
    s.markMissing('LM03');
    s.undo();
    assert.equal(s.stateOf('LM03'), 'todo');
    s.undo();
    assert.equal(s.stateOf('LM02'), 'todo');
    assert.equal(s.activeId, 'LM02', 'selection comes back too');
    s.redo();
    s.redo();
    assert.equal(s.stateOf('LM02'), 'placed');
    assert.equal(s.stateOf('LM03'), 'missing');
    assert.equal(s.canRedo, false);
  });

  test('a new edit after undo clears the redo history', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.undo();
    assert.equal(s.canRedo, true);
    s.place('LM02', hit(2));
    assert.equal(s.canRedo, false);
  });

  test('a whole marker drag is one undo step', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.beginMove();
    for (let x = 2; x <= 10; x++) s.moveTo('LM01', hit(x));
    s.endMove();
    assert.deepEqual(s.point('LM01').position, [10, 0, 0]);
    s.undo();
    assert.deepEqual(s.point('LM01').position, [1, 0, 0]);
  });

  test('endMove without beginMove adds nothing', () => {
    const s = fresh();
    s.endMove();
    assert.equal(s.canUndo, false);
  });

  test('undo covers template edits', () => {
    const s = fresh();
    s.addDefs(['Bregma']);
    s.undo();
    assert.equal(s.template.landmarks.length, 3);
  });

  test('selecting a landmark is not an undo step', () => {
    const s = fresh();
    s.setActive('LM03');
    assert.equal(s.canUndo, false);
  });

  test('history is capped at 200 steps', () => {
    const s = fresh();
    for (let i = 0; i < 250; i++) s.place('LM01', hit(i));
    assert.equal(s.undoStack.length, 200);
  });

  test('change events fire with a kind for each kind of edit', () => {
    const s = fresh();
    const kinds = changes(s);
    s.place('LM01', hit(1));
    s.beginMove();
    s.moveTo('LM01', hit(2));
    s.endMove();
    s.markMissing('LM02');
    s.undo();
    s.redo();
    s.setActive('LM03'); // already selected after redo: no event
    s.setActive('LM01');
    assert.deepEqual(kinds, ['place', 'move', 'commit', 'status', 'undo', 'redo', 'active']);
  });
});

describe('template editing', () => {
  test('addDefs gives the next free LM numbers and skips blank lines', () => {
    const s = fresh();
    s.addDefs(['Bregma', '  ', '', ' Lambda ']);
    assert.deepEqual(s.template.landmarks.slice(3).map((d) => [d.id, d.name]), [['LM04', 'Bregma'], ['LM05', 'Lambda']]);
  });

  test('addDefs continues numbering after the highest existing LM id', () => {
    const s = new Session({ id: 't', name: 't', version: '1', landmarks: [{ id: 'LM02', name: 'x' }] });
    s.addDefs(['A']);
    assert.equal(s.template.landmarks[1].id, 'LM03');
  });

  test('adding the first landmark to an empty template selects it', () => {
    const s = fresh();
    s.newTemplate();
    assert.equal(s.activeId, null);
    s.addDefs(['First']);
    assert.equal(s.activeId, 'LM01');
  });

  test('renaming and describing a landmark', () => {
    const s = fresh();
    assert.equal(s.updateDef('LM01', { name: ' Nasion point ', description: ' Here ' }), null);
    assert.equal(s.def('LM01').name, 'Nasion point');
    assert.equal(s.def('LM01').description, 'Here');
    s.updateDef('LM01', { description: '' });
    assert.equal('description' in s.def('LM01'), false);
  });

  test('id changes are validated', () => {
    const s = fresh();
    assert.match(s.updateDef('LM01', { id: '' }), /needs an ID/);
    assert.match(s.updateDef('LM01', { id: 'has space' }), /letters, digits/);
    assert.match(s.updateDef('LM01', { id: 'LM02' }), /already used/);
    assert.match(s.updateDef('LM01', { name: '  ' }), /needs a name/);
    s.place('LM01', hit(1));
    assert.match(s.updateDef('LM01', { id: 'N' }), /already has data/);
  });

  test('changing an id updates pairs and the selection', () => {
    const s = fresh();
    s.setActive('LM02');
    assert.equal(s.updateDef('LM02', { id: 'ZYL' }), null);
    assert.equal(s.def('LM03').bilateral_pair, 'ZYL');
    assert.equal(s.activeId, 'ZYL');
  });

  test('an unchanged edit is not an undo step', () => {
    const s = fresh();
    s.updateDef('LM01', { name: 'Nasion' });
    s.setTemplateField('name', ' Tiny set ');
    assert.equal(s.canUndo, false);
  });

  test('pairs stay symmetric', () => {
    const s = fresh();
    s.addDefs(['Porion L']);
    s.setPair('LM04', 'LM02');
    assert.equal(s.def('LM04').bilateral_pair, 'LM02');
    assert.equal(s.def('LM02').bilateral_pair, 'LM04');
    assert.equal(s.def('LM03').bilateral_pair, undefined, 'old partner is freed');
    s.setPair('LM04', null);
    assert.equal(s.def('LM02').bilateral_pair, undefined);
    s.setPair('LM01', 'LM01');
    assert.equal(s.def('LM01').bilateral_pair, undefined, 'cannot pair with itself');
  });

  test('removing a landmark removes its point and its pair link', () => {
    const s = fresh();
    s.place('LM02', hit(1));
    s.removeDef('LM02');
    assert.equal(s.def('LM02'), null);
    assert.equal(s.point('LM02'), null);
    assert.equal(s.def('LM03').bilateral_pair, undefined);
  });

  test('moveDef reorders and ignores moves off the ends', () => {
    const s = fresh();
    s.moveDef('LM03', -1);
    assert.deepEqual(s.template.landmarks.map((d) => d.id), ['LM01', 'LM03', 'LM02']);
    s.moveDef('LM01', -1);
    s.moveDef('LM02', 1);
    assert.deepEqual(s.template.landmarks.map((d) => d.id), ['LM01', 'LM03', 'LM02']);
    assert.equal(s.undoStack.length, 1, 'refused moves are not undo steps');
  });

  test('template fields are trimmed; empty removes optional ones', () => {
    const s = fresh();
    s.setTemplateField('description', ' For class ');
    assert.equal(s.template.description, 'For class');
    s.setTemplateField('description', '');
    assert.equal('description' in s.template, false);
  });

  test('newTemplate empties template and points but can be undone', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.newTemplate();
    assert.equal(s.template.landmarks.length, 0);
    assert.equal(s.template.dimensions, 3);
    assert.equal(s.points.length, 0);
    s.undo();
    assert.equal(s.template.landmarks.length, 3);
    assert.equal(s.points.length, 1);
  });
});

describe('loading and resetting', () => {
  test('load replaces template and points, clears history', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    s.load(EXAMPLE_TEMPLATE, [{ id: 'LM01', template_id: 'LM01', status: 'placed', position: [9, 9, 9] }]);
    assert.equal(s.template.landmarks.length, EXAMPLE_TEMPLATE.landmarks.length);
    assert.equal(s.canUndo, false);
    assert.equal(s.activeId, 'LM02');
  });

  test('replacePoint changes a point without an undo step', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    const steps = s.undoStack.length;
    s.replacePoint('LM01', { position: [2, 2, 2] });
    assert.deepEqual(s.point('LM01').position, [2, 2, 2]);
    assert.equal(s.undoStack.length, steps);
  });

  test('resetPoints keeps the template, drops points and history', () => {
    const s = fresh();
    s.addDefs(['Extra']);
    s.place('LM01', hit(1));
    s.resetPoints();
    assert.equal(s.template.landmarks.length, 4);
    assert.equal(s.points.length, 0);
    assert.equal(s.canUndo, false);
    assert.equal(s.activeId, 'LM01');
  });
});

describe('specimen sets', () => {
  const twoSpecimens = () => {
    const s = fresh();
    s.current.specimen = { id: 'A' };
    const b = s.addRecord({ specimen: { id: 'B' } });
    return { s, a: s.records[0], b };
  };

  test('each specimen has its own points; points means the current one', () => {
    const { s, a, b } = twoSpecimens();
    s.place('LM01', hit(1));
    s.switchTo(b.uid);
    assert.equal(s.points.length, 0);
    assert.equal(s.activeId, 'LM01', 'starts at the first landmark still to do');
    s.place('LM02', hit(2));
    assert.deepEqual(a.points.map((p) => p.id), ['LM01']);
    assert.deepEqual(b.points.map((p) => p.id), ['LM02']);
    assert.deepEqual(s.progressOf(a), { done: 1, total: 3 });
  });

  test('switching is not an undo step and reports whether it changed anything', () => {
    const { s, b } = twoSpecimens();
    assert.equal(s.switchTo(b.uid), true);
    assert.equal(s.switchTo(b.uid), false);
    assert.equal(s.canUndo, false);
  });

  test('neighbour wraps round', () => {
    const { s, a, b } = twoSpecimens();
    assert.equal(s.neighbour(1), b);
    assert.equal(s.neighbour(-1), b);
    s.switchTo(b.uid);
    assert.equal(s.neighbour(1), a);
  });

  test('undo goes back to the specimen the change was made on', () => {
    const { s, a, b } = twoSpecimens();
    s.place('LM01', hit(1));
    s.switchTo(b.uid);
    const kinds = [];
    s.addEventListener('change', (e) => kinds.push(e.detail));
    s.undo();
    assert.equal(s.current, a);
    assert.equal(a.points.length, 0);
    assert.deepEqual(kinds, [{ kind: 'undo', switched: true }]);
  });

  test('template edits act on every specimen', () => {
    const { s, a, b } = twoSpecimens();
    s.place('LM02', hit(1));
    s.switchTo(b.uid);
    assert.match(s.updateDef('LM02', { id: 'ZYL' }), /already has data/, 'locked by data on another specimen');
    s.place('LM02', hit(2));
    s.removeDef('LM02');
    assert.equal(a.points.length, 0);
    assert.equal(b.points.length, 0);
    assert.equal(a.dirty, true, 'changed files need saving');
    s.undo();
    assert.equal(a.points.length, 1);
    assert.equal(b.points.length, 1);
  });

  test('new ids skip ids used by any specimen', () => {
    const { s, b } = twoSpecimens();
    s.switchTo(b.uid);
    s.records[0].points.push({ id: 'LM04', template_id: null, status: 'placed', position: [0, 0, 0] });
    s.addDefs(['New']);
    assert.equal(s.template.landmarks.at(-1).id, 'LM05');
  });

  test('newTemplate clears every specimen', () => {
    const { s, a, b } = twoSpecimens();
    s.place('LM01', hit(1));
    s.switchTo(b.uid);
    s.place('LM01', hit(1));
    s.newTemplate();
    assert.equal(a.points.length + b.points.length, 0);
  });

  test('adding after a record keeps replicates together; adding clears undo', () => {
    const { s, a } = twoSpecimens();
    s.place('LM01', hit(1));
    const r2 = s.addRecord({ specimen: { id: 'A', replicate: 2 } }, { after: a });
    assert.deepEqual(s.records.map((r) => r.specimen.id), ['A', 'A', 'B']);
    assert.equal(s.records[1], r2);
    assert.equal(s.canUndo, false);
  });

  test('removing the current specimen moves to a neighbour; the last one is replaced by an empty one', () => {
    const { s, a, b } = twoSpecimens();
    s.switchTo(b.uid);
    s.removeRecord(b.uid);
    assert.equal(s.current, a);
    s.removeRecord(a.uid);
    assert.equal(s.records.length, 1);
    assert.equal(s.points.length, 0);
  });

  test('replaceRecords swaps the set and can bring a new template', () => {
    const s = fresh();
    s.place('LM01', hit(1));
    const recs = [newRecord({ specimen: { id: 'X' } })];
    s.replaceRecords(recs, EXAMPLE_TEMPLATE);
    assert.equal(s.current.specimen.id, 'X');
    assert.equal(s.template.id, 'cranium-basic');
    assert.throws(() => s.replaceRecords([], { ...SMALL_TEMPLATE, dimensions: 2 }), /2D template/);
  });

  test('a shuffled order decides what comes next', () => {
    const s = fresh();
    s.current.order = ['LM03', 'LM01', 'LM02'];
    s.activeId = s.nextTodo(null);
    assert.equal(s.activeId, 'LM03');
    s.place('LM03', hit(1));
    assert.equal(s.activeId, 'LM01');
    s.place('LM01', hit(1));
    assert.equal(s.activeId, 'LM02');
  });

  test('an outdated shuffled order (template changed) falls back to template order', () => {
    const s = fresh();
    s.current.order = ['LM03', 'LM01'];
    assert.equal(s.nextTodo(null), 'LM01');
  });

  test('replicateOf reads specimen.replicate', () => {
    assert.equal(replicateOf(newRecord()), 1);
    assert.equal(replicateOf(newRecord({ specimen: { id: 'A', replicate: 2 } })), 2);
  });
});

describe('planes in the template (v0.4)', () => {
  test('add a plane from three or more landmarks', () => {
    const s = fresh();
    assert.deepEqual(s.addPlane({ name: ' Midsagittal ', landmarks: ['LM01', 'LM02', 'LM03'] }), { id: 'PL01' });
    assert.deepEqual(s.template.planes, [{ id: 'PL01', name: 'Midsagittal', landmarks: ['LM01', 'LM02', 'LM03'] }]);
    assert.equal(s.addPlane({ name: 'Second', landmarks: ['LM03', 'LM02', 'LM01'], description: 'x' }).id, 'PL02');
    s.undo();
    assert.equal(s.template.planes.length, 1, 'adding is one undo step');
  });

  test('plane definitions are checked', () => {
    const s = fresh();
    assert.match(s.addPlane({ name: '', landmarks: ['LM01', 'LM02', 'LM03'] }).error, /needs a name/);
    assert.match(s.addPlane({ name: 'P', landmarks: ['LM01', 'LM02'] }).error, /at least three/);
    assert.match(s.addPlane({ name: 'P', landmarks: ['LM01', 'LM01', 'LM02'] }).error, /only once/);
    assert.match(s.addPlane({ name: 'P', landmarks: ['LM01', 'LM02', 'LM99'] }).error, /LM99 is not a landmark/);
    assert.equal(s.template.planes, undefined);
    assert.equal(s.canUndo, false);
  });

  test('edit and remove a plane', () => {
    const s = fresh();
    s.addDefs(['Extra']);
    s.addPlane({ name: 'P', landmarks: ['LM01', 'LM02', 'LM03'] });
    assert.equal(s.updatePlane('PL01', { name: 'Midline', landmarks: ['LM01', 'LM02', 'LM03', 'LM04'] }), null);
    assert.deepEqual(s.plane('PL01').landmarks, ['LM01', 'LM02', 'LM03', 'LM04']);
    assert.match(s.updatePlane('PL01', { landmarks: ['LM01'] }), /at least three/);
    s.removePlane('PL01');
    assert.equal('planes' in s.template, false, 'an empty list is dropped');
  });

  test('renaming a landmark updates planes; deleting one removes it from planes', () => {
    const s = fresh();
    s.addPlane({ name: 'P', landmarks: ['LM01', 'LM02', 'LM03'] });
    s.updateDef('LM02', { id: 'ZYL' });
    assert.deepEqual(s.plane('PL01').landmarks, ['LM01', 'ZYL', 'LM03']);
    s.removeDef('LM03');
    assert.deepEqual(s.plane('PL01').landmarks, ['LM01', 'ZYL']);
  });

  test('plane ids and landmark ids never clash', () => {
    const s = fresh();
    s.addPlane({ name: 'P', landmarks: ['LM01', 'LM02', 'LM03'] });
    assert.match(s.updateDef('LM01', { id: 'PL01' }), /already used/);
  });

  test('templates with a non-list planes field are refused', () => {
    assert.match(checkTemplate({ ...SMALL_TEMPLATE, planes: {} }), /isn’t a list/);
    assert.equal(checkTemplate({ ...SMALL_TEMPLATE, planes: [] }), null);
  });
});
