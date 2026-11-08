import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Session, ADHOC, FORMAT } from '../../js/session.js';
import {
  buildLandmarkFile,
  parseLandmarkFile,
  meshMatches,
  exportOrder,
  orderedPoints,
  LandmarkFileError,
  APP,
  newerVersion,
} from '../../js/landmark-file.js';
import { hit, MESH, SMALL_TEMPLATE } from '../fixtures.js';

// The v0.1 example from the spec, with the v0.2 dimensions field.
const SPEC_EXAMPLE = {
  format: 'landmark-json',
  version: '0.2.0',
  specimen: {
    id: 'SKULL_014',
    notes: 'Left zygomatic arch broken',
    mesh: { file: 'SKULL_014.ply', sha256: '9f2c...e41a', units: 'mm', vertex_count: 248113, face_count: 496222 },
  },
  template: {
    id: 'cranium-basic',
    name: 'Cranium, basic set',
    version: '1.0',
    dimensions: 3,
    landmarks: [
      { id: 'LM01', name: 'Nasion' },
      { id: 'LM02', name: 'Zygion L', bilateral_pair: 'LM03' },
      { id: 'LM03', name: 'Zygion R', bilateral_pair: 'LM02' },
    ],
    export_order: ['LM01', 'LM02', 'LM03'],
  },
  landmarks: [
    { id: 'LM01', template_id: 'LM01', status: 'placed', position: [12.4031, -3.221, 88.9172], anchor: { face: 182044, bary: [0.21, 0.47, 0.32] }, placed_at: '2026-11-06T15:02:11Z' },
    { id: 'LM02', template_id: 'LM02', status: 'missing', position: null, note: 'Arch broken' },
    { id: 'LM03', template_id: 'LM03', status: 'placed', position: [-61.0874, 2.5531, 40.1186], anchor: { face: 90317, bary: [0.66, 0.1, 0.24] } },
  ],
  provenance: { software: 'landmarker', software_version: '0.1.0', operator: 'student01', created: '2026-11-06T14:55:00Z', modified: '2026-11-06T15:02:11Z' },
};

function sessionWithData() {
  const s = new Session(SMALL_TEMPLATE);
  s.place('LM01', hit(12.4031, -3.221, 88.917243, 182044));
  s.markMissing('LM02');
  s.setNote('LM02', 'Arch broken');
  s.place('LM03', hit(-61.0874, 2.5531, 40.1186, 90317));
  s.toggleEstimated('LM03');
  s.place(ADHOC, hit(1, 2, 3));
  return s;
}

const build = (s, extra = {}) =>
  buildLandmarkFile({ session: s, mesh: MESH, units: 'mm', specimenId: 'SKULL_014', notes: '', operator: '', ...extra });

const roundTrip = (s, extra) => parseLandmarkFile(build(s, extra).text, 'SKULL_014.lmk.json');

describe('writing (spec v0.2)', () => {
  test('required top-level fields, in spec order', () => {
    const { doc, text } = build(sessionWithData(), { notes: 'Left zygomatic arch broken', operator: 'student01' });
    assert.deepEqual(Object.keys(doc), ['format', 'version', 'specimen', 'template', 'landmarks', 'provenance']);
    assert.equal(doc.format, 'landmark-json');
    assert.equal(doc.version, FORMAT.version);
    assert.equal(doc.specimen.id, 'SKULL_014');
    assert.equal(doc.specimen.notes, 'Left zygomatic arch broken');
    assert.deepEqual(doc.specimen.mesh, {
      file: 'SKULL_014.ply',
      sha256: MESH.sha256,
      units: 'mm',
      vertex_count: 248113,
      face_count: 496222,
    });
    assert.equal(doc.specimen.image, undefined, 'a mesh source, never an image');
    assert.equal(doc.template.dimensions, 3);
    assert.equal(doc.provenance.software, APP.name);
    assert.equal(doc.provenance.operator, 'student01');
    assert.match(doc.provenance.created, /Z$/);
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(JSON.parse(text), doc, 'text and object agree');
  });

  test('landmark entries follow the spec table', () => {
    const { doc } = build(sessionWithData());
    const [lm1, lm2, lm3, ah] = doc.landmarks;
    assert.deepEqual(Object.keys(lm1).sort(), ['anchor', 'id', 'normal', 'placed_at', 'position', 'status', 'template_id']);
    assert.deepEqual(lm1.position, [12.4031, -3.221, 88.917243]);
    assert.deepEqual(lm1.anchor, { face: 182044, bary: [0.2, 0.3, 0.5] });
    assert.equal(lm2.status, 'missing');
    assert.equal(lm2.position, null, 'missing is null, never a sentinel number');
    assert.equal(lm2.anchor, undefined);
    assert.equal(lm2.note, 'Arch broken');
    assert.equal(lm3.status, 'estimated');
    assert.equal(ah.template_id, null);
    assert.equal(ah.id, 'AH01');
  });

  test('empty notes and operator leave the fields out', () => {
    const { doc } = build(sessionWithData());
    assert.equal('notes' in doc.specimen, false);
    assert.equal('operator' in doc.provenance, false);
  });

  test('coordinate arrays are written on one line', () => {
    const { text } = build(sessionWithData());
    assert.match(text, /"position": \[12\.4031, -3\.221, 88\.917243\]/);
    assert.match(text, /"bary": \[0\.2, 0\.3, 0\.5\]/);
    assert.match(text, /"position": null/);
  });

  test('landmarks are written in export order, ad hoc last', () => {
    const s = sessionWithData();
    s.template.export_order = ['LM03', 'LM01', 'LM02'];
    assert.deepEqual(build(s).doc.landmarks.map((p) => p.id), ['LM03', 'LM01', 'LM02', 'AH01']);
  });

  test('saving does not change the session', () => {
    const s = sessionWithData();
    const before = JSON.stringify(s.points);
    build(s);
    assert.equal(JSON.stringify(s.points), before);
  });
});

describe('keeping fields this app does not know', () => {
  const base = {
    format: 'landmark-json',
    version: '0.2.0',
    specimen: { id: 'old', collection: 'MfN Berlin', notes: 'old notes', mesh: { file: 'x', scanner: 'Artec Space Spider' } },
    curves: [{ id: 'C1', template_id: 'CV01', status: 'placed' }],
    surfaces: [],
    lab_field: { a: 1 },
    provenance: { created: '2026-01-01T00:00:00Z', operator: 'old', reviewed_by: 'BV' },
    extensions: { mylab: { batch: 7 } },
  };

  test('unknown fields everywhere survive a save', () => {
    const { doc } = build(sessionWithData(), { base, notes: 'new', operator: 'student01' });
    assert.deepEqual(doc.curves, base.curves);
    assert.deepEqual(doc.surfaces, []);
    assert.deepEqual(doc.lab_field, { a: 1 });
    assert.deepEqual(doc.extensions, { mylab: { batch: 7 } });
    assert.equal(doc.specimen.collection, 'MfN Berlin');
    assert.equal(doc.specimen.mesh.scanner, 'Artec Space Spider');
    assert.equal(doc.provenance.reviewed_by, 'BV');
  });

  test('known fields are updated, the creation date is kept', () => {
    const { doc } = build(sessionWithData(), { base, notes: 'new', operator: 'student01' });
    assert.equal(doc.specimen.id, 'SKULL_014');
    assert.equal(doc.specimen.notes, 'new');
    assert.equal(doc.specimen.mesh.file, 'SKULL_014.ply');
    assert.equal(doc.provenance.created, '2026-01-01T00:00:00Z');
    assert.equal(doc.provenance.operator, 'student01');
    assert.notEqual(doc.provenance.modified, base.provenance.created);
  });

  test('clearing notes in the app removes the old notes', () => {
    const { doc } = build(sessionWithData(), { base, notes: '' });
    assert.equal('notes' in doc.specimen, false);
  });

  test('known mesh fields come first, extensions last', () => {
    const { doc } = build(sessionWithData(), { base });
    assert.deepEqual(Object.keys(doc.specimen.mesh), ['file', 'sha256', 'units', 'vertex_count', 'face_count', 'scanner']);
    const keys = Object.keys(doc);
    assert.equal(keys.at(-1), 'extensions');
    assert.equal(keys.at(-2), 'provenance');
  });

  test('a stray image source in the base is dropped (this is a mesh file)', () => {
    const { doc } = build(sessionWithData(), { base: { ...base, specimen: { ...base.specimen, image: { file: 'a.jpg' } } } });
    assert.equal(doc.specimen.image, undefined);
  });

  test('round trip keeps everything: save, open, save again gives the same content', () => {
    const first = build(sessionWithData(), { base, operator: 'student01' });
    const parsed = parseLandmarkFile(first.text, 'a.lmk.json');
    const s2 = new Session(parsed.template);
    s2.load(parsed.template, parsed.points);
    const second = build(s2, { base: parsed.doc, operator: 'student01' });
    const strip = (d) => ({ ...d, provenance: { ...d.provenance, modified: null } });
    assert.deepEqual(strip(second.doc), strip(first.doc));
  });
});

describe('reading', () => {
  test('round trip gives back the template and points', () => {
    const s = sessionWithData();
    const r = roundTrip(s);
    assert.deepEqual(r.template, s.template);
    assert.deepEqual(r.points.map((p) => [p.id, p.status]), [['LM01', 'placed'], ['LM02', 'missing'], ['LM03', 'estimated'], ['AH01', 'placed']]);
    assert.deepEqual(r.points[0].position, [12.4031, -3.221, 88.917243]);
    assert.deepEqual(r.warnings, []);
  });

  test('reads the example file from the spec', () => {
    const r = parseLandmarkFile(JSON.stringify(SPEC_EXAMPLE), 'SKULL_014.lmk.json');
    assert.equal(r.points.length, 3);
    assert.equal(r.points[1].status, 'missing');
    assert.equal(r.template.landmarks[1].bilateral_pair, 'LM03');
  });

  test('a v0.1 file without template dimensions still opens', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    doc.version = '0.1.0';
    delete doc.template.dimensions;
    assert.equal(parseLandmarkFile(JSON.stringify(doc), 'old.lmk.json').points.length, 3);
  });

  const refused = [
    ['not JSON', '{', /isn’t valid JSON/],
    ['other JSON', '{"a": 1}', /not a landmark file/],
    ['no version', { ...SPEC_EXAMPLE, version: undefined }, /no readable format version/],
    ['major version 1', { ...SPEC_EXAMPLE, version: '1.0.0' }, /can’t read safely/],
    ['2D image file', { ...SPEC_EXAMPLE, specimen: { id: 'x', image: { file: 'a.jpg', width: 10, height: 10 } } }, /2D landmarks on an image/],
    ['no mesh', { ...SPEC_EXAMPLE, specimen: { id: 'x' } }, /which mesh/],
    ['2D template', { ...SPEC_EXAMPLE, template: { ...SPEC_EXAMPLE.template, dimensions: 2 } }, /2D template/],
    ['template by reference', { ...SPEC_EXAMPLE, template: { ref: 'cranium.template.json', id: 'c', version: '1' } }, /separate template file/],
    ['no template', { ...SPEC_EXAMPLE, template: undefined }, /no template/],
    ['repeated template id', { ...SPEC_EXAMPLE, template: { ...SPEC_EXAMPLE.template, landmarks: [{ id: 'A', name: 'a' }, { id: 'A', name: 'b' }] } }, /missing or repeated ID/],
  ];
  for (const [label, input, message] of refused) {
    test(`refuses: ${label}`, () => {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      assert.throws(() => parseLandmarkFile(text, 'f.lmk.json'), (err) => err instanceof LandmarkFileError && message.test(err.message));
    });
  }

  test('a newer minor version opens with a warning', () => {
    const r = parseLandmarkFile(JSON.stringify({ ...SPEC_EXAMPLE, version: '0.9.0' }), 'n.lmk.json');
    assert.match(r.warnings[0], /newer format version \(0\.9\.0\)/);
  });

  test('unreadable entries are skipped with a warning, the rest is kept', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    doc.landmarks.push(
      { id: 'LM01', template_id: 'LM01', status: 'placed', position: [1, 2, 3] }, // duplicate id
      { id: 'X', status: 'wobbly', position: [1, 2, 3] }, // unknown status
      { id: 'Y', status: 'placed', position: [1, 2] }, // 2D position
      { id: 'Z', status: 'placed', position: [1, 'a', 3] }, // not numbers
      null
    );
    const r = parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json');
    assert.equal(r.points.length, 3);
    assert.match(r.warnings.join(' '), /5 landmark entries were unreadable/);
  });

  test('points pointing at landmarks not in the template become ad hoc', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    doc.landmarks.push({ id: 'LM99', template_id: 'LM99', status: 'placed', position: [0, 0, 0] });
    const r = parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json');
    assert.equal(r.points.find((p) => p.id === 'LM99').template_id, null);
    assert.match(r.warnings.join(' '), /became ad hoc/);
  });

  test('missing template_id is filled in from a matching template id', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    delete doc.landmarks[0].template_id;
    doc.landmarks.push({ id: 'EXTRA', status: 'placed', position: [0, 0, 0] });
    const r = parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json');
    assert.equal(r.points[0].template_id, 'LM01');
    assert.equal(r.points.at(-1).template_id, null);
  });

  test('a missing landmark with leftover coordinates is read as null', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    doc.landmarks[1].position = [1, 2, 3];
    assert.equal(parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json').points[1].position, null);
  });

  test('template landmarks without a name get their id as name', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    delete doc.template.landmarks[0].name;
    assert.equal(parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json').template.landmarks[0].name, 'LM01');
  });
});

describe('mesh matching and order', () => {
  test('match by SHA-256, case-insensitive', () => {
    assert.equal(meshMatches({ sha256: MESH.sha256.toUpperCase() }, MESH), true);
    assert.equal(meshMatches({ sha256: 'cd'.repeat(32), file: MESH.name, face_count: MESH.faceCount }, MESH), false, 'hash wins over name');
  });

  test('without a hash, match by file name and face count', () => {
    assert.equal(meshMatches({ file: MESH.name, face_count: MESH.faceCount }, MESH), true);
    assert.equal(meshMatches({ file: MESH.name, face_count: 1 }, MESH), false);
    assert.equal(meshMatches(null, MESH), false);
  });

  test('export order: export_order first, unknown ids dropped, the rest appended', () => {
    const t = { landmarks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }], export_order: ['C', 'GONE', 'A'] };
    assert.deepEqual(exportOrder(t), ['C', 'A', 'B']);
    assert.deepEqual(exportOrder({ landmarks: [{ id: 'A' }, { id: 'B' }] }), ['A', 'B']);
  });

  test('orderedPoints sorts ad hoc points numerically', () => {
    const pts = ['AH10', 'AH2', 'AH1'].map((id) => ({ id, template_id: null }));
    assert.deepEqual(orderedPoints({ landmarks: [] }, pts).map((p) => p.id), ['AH1', 'AH2', 'AH10']);
  });
});

describe('format versions and replicates (v0.3)', () => {
  test('a replicate after the first is written as 0.3.0 with specimen.replicate', () => {
    const { doc } = build(sessionWithData(), { replicate: 2 });
    assert.equal(doc.version, '0.3.0');
    assert.equal(doc.specimen.replicate, 2);
    assert.deepEqual(Object.keys(doc.specimen).slice(0, 2), ['id', 'replicate']);
  });

  test('a first replicate is written as 0.2.0 without the field', () => {
    const { doc } = build(sessionWithData(), { replicate: 1, base: { version: '0.2.0', specimen: { replicate: 1 } } });
    assert.equal(doc.version, '0.2.0');
    assert.equal('replicate' in doc.specimen, false);
  });

  test('re-saving a newer file keeps its version', () => {
    assert.equal(build(sessionWithData(), { base: { version: '0.3.0' } }).doc.version, '0.3.0');
    assert.equal(build(sessionWithData(), { base: { version: '0.9.1' } }).doc.version, '0.9.1');
    assert.equal(build(sessionWithData(), { base: { version: '0.1.0' } }).doc.version, '0.2.0');
    assert.equal(build(sessionWithData(), { base: { version: 'odd' } }).doc.version, '0.2.0');
  });

  test('newerVersion compares numerically', () => {
    assert.equal(newerVersion('0.10.0', '0.9.0'), '0.10.0');
    assert.equal(newerVersion(undefined, '0.2.0'), '0.2.0');
  });

  test('0.3 files open without a warning; their replicate is kept', () => {
    const { text } = build(sessionWithData(), { replicate: 3 });
    const r = parseLandmarkFile(text, 'A_r3.lmk.json');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.doc.specimen.replicate, 3);
  });

  test('a bad replicate number is dropped with a warning', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    doc.specimen.replicate = 'two';
    const r = parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json');
    assert.match(r.warnings.join(' '), /treated as replicate 1/);
    assert.equal('replicate' in r.doc.specimen, false);
  });

  test('template and points can be passed without a session', () => {
    const s = sessionWithData();
    const a = build(s).doc;
    const b = buildLandmarkFile({ template: s.template, points: s.points, mesh: { file: MESH.name, sha256: MESH.sha256, units: 'cm', vertex_count: 1, face_count: 2 }, specimenId: 'SKULL_014' }).doc;
    assert.deepEqual(b.landmarks, a.landmarks);
    assert.deepEqual(b.specimen.mesh, { file: MESH.name, sha256: MESH.sha256, units: 'cm', vertex_count: 1, face_count: 2 });
  });
});

describe('planes in files (v0.4)', () => {
  const withPlane = () => {
    const s = sessionWithData();
    s.addPlane({ name: 'Midsagittal', landmarks: ['LM01', 'LM02', 'LM03'] });
    return s;
  };

  test('a template with planes is written as 0.4.0 and the planes are kept', () => {
    const { doc, text } = build(withPlane());
    assert.equal(doc.version, '0.4.0');
    assert.deepEqual(doc.template.planes, [{ id: 'PL01', name: 'Midsagittal', landmarks: ['LM01', 'LM02', 'LM03'] }]);
    const r = parseLandmarkFile(text, 'a.lmk.json');
    assert.deepEqual(r.warnings, [], 'this app reads 0.4 without a note');
    assert.deepEqual(r.template.planes, doc.template.planes);
  });

  test('replicates with planes are still 0.4.0', () => {
    assert.equal(build(withPlane(), { replicate: 2 }).doc.version, '0.4.0');
  });

  test('no planes: no version bump', () => {
    assert.equal(build(sessionWithData()).doc.version, '0.2.0');
  });

  test('unusable plane definitions are cleaned up with a note', () => {
    const doc = structuredClone(SPEC_EXAMPLE);
    doc.version = '0.4.0';
    doc.template.planes = [
      { id: 'PL01', name: 'Ok', landmarks: ['LM01', 'LM02', 'LM03'] },
      { id: 'PL02', landmarks: ['LM01', 'LM99', 'LM02'] },
      { name: 'no id', landmarks: [] },
      'nonsense',
    ];
    const r = parseLandmarkFile(JSON.stringify(doc), 'f.lmk.json');
    assert.deepEqual(r.template.planes.map((p) => [p.id, p.name, p.landmarks]), [
      ['PL01', 'Ok', ['LM01', 'LM02', 'LM03']],
      ['PL02', 'PL02', ['LM01', 'LM02']],
    ]);
    assert.match(r.warnings.join(' '), /2 planes were unreadable/);
    assert.match(r.warnings.join(' '), /named landmarks not in the template/);
  });
});
