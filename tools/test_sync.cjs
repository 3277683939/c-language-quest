/**
 * Test suite for overrides/sync-core.js
 * Run with: node tools/test_sync.cjs
 */
'use strict';

const assert = require('assert');
const syncCore = require('../overrides/sync-core.js');

const {
  sanitizeForCloud,
  stateToDocument,
  documentToState,
  mergeProgress,
  createBlankDocument,
  MAX_DOCUMENT_BYTES
} = syncCore;

let testCount = 0;
function test(name, fn) {
  testCount++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('Running test_sync.cjs (Sync Core & Merge Engine Tests)...');

test('1. Idempotency: merge(A, A) === A', () => {
  const doc = createBlankDocument('dev1');
  doc.answers['h-1-0'] = { attempts: 3, correct: 2, last: 'B', updatedAt: 1000, devices: { dev1: { attempts: 3, correct: 2 } } };
  doc.wrong['h-1-0'] = { active: true, updatedAt: 1000 };
  doc.favorites['h-1-1'] = { active: true, updatedAt: 1000 };
  doc.levels['h-1-0'] = { passed: true, score: 90, bestScore: 90, updatedAt: 1000 };
  doc.days = ['2026-11-01'];
  doc.drafts['u1'] = { text: 'int a = 1;', updatedAt: 1000, conflicts: [] };
  doc.selfChecks['u1'] = { mastered: true, updatedAt: 1000, checkedAt: '2026-11-01' };

  const merged = mergeProgress(doc, doc, { now: 1000 });
  assert.strictEqual(merged.answers['h-1-0'].attempts, 3);
  assert.strictEqual(merged.answers['h-1-0'].correct, 2);
  assert.strictEqual(merged.wrong['h-1-0'].active, true);
  assert.strictEqual(merged.favorites['h-1-1'].active, true);
  assert.strictEqual(merged.levels['h-1-0'].passed, true);
  assert.strictEqual(merged.levels['h-1-0'].score, 90);
  assert.deepStrictEqual(merged.days, ['2026-11-01']);
  assert.strictEqual(merged.drafts['u1'].text, 'int a = 1;');
  assert.strictEqual(merged.selfChecks['u1'].mastered, true);
});

test('2. Concurrent progress on different questions', () => {
  const docA = createBlankDocument('devA');
  docA.answers['q1'] = { attempts: 1, correct: 1, last: 'A', updatedAt: 1000, devices: { devA: { attempts: 1, correct: 1 } } };

  const docB = createBlankDocument('devB');
  docB.answers['q2'] = { attempts: 2, correct: 1, last: 'C', updatedAt: 1050, devices: { devB: { attempts: 2, correct: 1 } } };

  const merged = mergeProgress(docA, docB, { now: 1100 });
  assert.strictEqual(Object.keys(merged.answers).length, 2);
  assert.strictEqual(merged.answers['q1'].attempts, 1);
  assert.strictEqual(merged.answers['q2'].attempts, 2);
});

test('3. No double counting of identical snapshots & multi-device tracking', () => {
  // Snapshot with 3 attempts on devA
  const docA = createBlankDocument('devA');
  docA.answers['q1'] = { attempts: 3, correct: 2, last: 'B', updatedAt: 1000, devices: { devA: { attempts: 3, correct: 2 } } };

  // Device B has the exact same snapshot synced earlier
  const docB = createBlankDocument('devB');
  docB.answers['q1'] = { attempts: 3, correct: 2, last: 'B', updatedAt: 1000, devices: { devA: { attempts: 3, correct: 2 } } };

  const merged = mergeProgress(docA, docB, { now: 1000 });
  assert.strictEqual(merged.answers['q1'].attempts, 3, 'Attempts must not double count identical snapshot');
  assert.strictEqual(merged.answers['q1'].correct, 2, 'Correct count must not double count');

  // Now Device B makes 2 new attempts on q1
  docB.answers['q1'].devices['devB'] = { attempts: 2, correct: 1 };
  docB.answers['q1'].attempts = 5;
  docB.answers['q1'].correct = 3;
  docB.answers['q1'].updatedAt = 2000;

  const merged2 = mergeProgress(docA, docB, { now: 2000 });
  assert.strictEqual(merged2.answers['q1'].attempts, 5, '3 from devA + 2 from devB = 5 total attempts');
  assert.strictEqual(merged2.answers['q1'].correct, 3);
});

test('4. Legacy answers without device breakdowns take max on migration', () => {
  const docA = createBlankDocument('devA');
  docA.answers['q1'] = { attempts: 4, correct: 3, last: 'A', updatedAt: 1000 };

  const docB = createBlankDocument('devB');
  docB.answers['q1'] = { attempts: 4, correct: 3, last: 'A', updatedAt: 1000 };

  const merged = mergeProgress(docA, docB, { now: 1000 });
  assert.strictEqual(merged.answers['q1'].attempts, 4, 'Legacy merge takes max and avoids double counting');
  assert.strictEqual(merged.answers['q1'].correct, 3);
});

test('5. Favorite deletion tombstone (LWW: does not resurrect)', () => {
  // DevA deleted favorite 'q_fav' at t=2000
  const docA = createBlankDocument('devA');
  docA.favorites['q_fav'] = { active: false, updatedAt: 2000 };

  // DevB still has favorite 'q_fav' from t=1000
  const docB = createBlankDocument('devB');
  docB.favorites['q_fav'] = { active: true, updatedAt: 1000 };

  const merged = mergeProgress(docA, docB, { now: 2500 });
  assert.strictEqual(merged.favorites['q_fav'].active, false, 'Deleted favorite must remain inactive (no resurrection)');

  const state = documentToState(merged);
  assert.strictEqual(state.favorites.includes('q_fav'), false, 'Inactive favorite must not appear in state.favorites');

  // Re-favoriting later at t=3000 resurrects intentionally
  docB.favorites['q_fav'] = { active: true, updatedAt: 3000 };
  const mergedAgain = mergeProgress(merged, docB, { now: 3500 });
  assert.strictEqual(mergedAgain.favorites['q_fav'].active, true);
  const stateAgain = documentToState(mergedAgain);
  assert.strictEqual(stateAgain.favorites.includes('q_fav'), true);
});

test('6. Wrong question deletion tombstone (LWW)', () => {
  const docA = createBlankDocument('devA');
  docA.wrong['q_wrong'] = { active: false, updatedAt: 2000 };

  const docB = createBlankDocument('devB');
  docB.wrong['q_wrong'] = { active: true, updatedAt: 1500 };

  const merged = mergeProgress(docA, docB, { now: 2500 });
  assert.strictEqual(merged.wrong['q_wrong'].active, false);
  const state = documentToState(merged);
  assert.strictEqual(state.wrong.includes('q_wrong'), false);
});

test('7. Self-check cancellation tombstone (LWW)', () => {
  const docA = createBlankDocument('devA');
  docA.selfChecks['u_check'] = { mastered: false, updatedAt: 2000, checkedAt: '2026-11-01' };

  const docB = createBlankDocument('devB');
  docB.selfChecks['u_check'] = { mastered: true, updatedAt: 1000, checkedAt: '2026-11-01' };

  const merged = mergeProgress(docA, docB, { now: 2500 });
  assert.strictEqual(merged.selfChecks['u_check'].mastered, false);
  const state = documentToState(merged);
  assert.strictEqual(state.selfChecks['u_check'], undefined, 'Cancelled self-check not in state');
});

test('8. Draft concurrent conflict preservation (no silent loss)', () => {
  const docA = createBlankDocument('devA');
  docA.drafts['unit1'] = { text: 'printf("hello from A");', updatedAt: 2000, deviceId: 'devA' };

  const docB = createBlankDocument('devB');
  docB.drafts['unit1'] = { text: 'printf("hello from B");', updatedAt: 1800, deviceId: 'devB' };

  const merged = mergeProgress(docA, docB, { now: 2500 });
  assert.strictEqual(merged.drafts['unit1'].text, 'printf("hello from A");', 'Newer draft text is primary');
  assert.strictEqual(merged.drafts['unit1'].conflicts.length, 1, 'Older conflicting draft preserved in conflicts');
  assert.strictEqual(merged.drafts['unit1'].conflicts[0].text, 'printf("hello from B");');

  const state = documentToState(merged);
  assert.strictEqual(state.drafts['unit1'], 'printf("hello from A");');
  assert.strictEqual(state.draftConflicts['unit1'].length, 1);
  assert.strictEqual(state.draftConflicts['unit1'][0].text, 'printf("hello from B");');
});

test('9. Level score & pass union', () => {
  const docA = createBlankDocument('devA');
  docA.levels['h-1-0'] = { passed: true, score: 80, bestScore: 80, updatedAt: 1000 };

  const docB = createBlankDocument('devB');
  docB.levels['h-1-0'] = { passed: false, score: 90, bestScore: 90, updatedAt: 1200 };

  const merged = mergeProgress(docA, docB, { now: 1500 });
  assert.strictEqual(merged.levels['h-1-0'].passed, true, 'Passed flag is OR combination');
  assert.strictEqual(merged.levels['h-1-0'].bestScore, 90, 'Highest score preserved');
});

test('10. Days array deduplicated and sorted', () => {
  const docA = createBlankDocument('devA');
  docA.days = ['2026-11-03', '2026-11-01'];

  const docB = createBlankDocument('devB');
  docB.days = ['2026-11-02', '2026-11-01'];

  const merged = mergeProgress(docA, docB, { now: 1500 });
  assert.deepStrictEqual(merged.days, ['2026-11-01', '2026-11-02', '2026-11-03']);
});

test('11. Sanitization whitelist strips sensitive and unapproved fields', () => {
  const maliciousDoc = {
    schemaVersion: 1,
    updatedAt: 1000,
    session: { token: 'secret-token-12345' },
    teaching: { prompt: 'deepseek instruction' },
    password: 'super-secret-password',
    apiKey: 'sk-1234567890',
    authToken: 'bearer-xyz',
    user_id: 'some-user-uuid',
    arbitraryPayload: { foo: 'bar' },
    answers: {
      q1: { attempts: 1, correct: 1, last: 'A' }
    }
  };

  const clean = sanitizeForCloud(maliciousDoc);
  assert.strictEqual(clean.session, undefined);
  assert.strictEqual(clean.teaching, undefined);
  assert.strictEqual(clean.password, undefined);
  assert.strictEqual(clean.apiKey, undefined);
  assert.strictEqual(clean.authToken, undefined);
  assert.strictEqual(clean.user_id, undefined);
  assert.strictEqual(clean.arbitraryPayload, undefined);
  assert.ok(clean.answers['q1']);
});

test('12. Document size limit rejection (> 2MB)', () => {
  const hugeDoc = createBlankDocument('dev');
  // Fill drafts with a massive string exceeding 2MB
  const chunk = 'x'.repeat(1024 * 512); // 512 KB
  hugeDoc.drafts['huge1'] = chunk;
  hugeDoc.drafts['huge2'] = chunk;
  hugeDoc.drafts['huge3'] = chunk;
  hugeDoc.drafts['huge4'] = chunk;
  hugeDoc.drafts['huge5'] = chunk; // > 2.5 MB

  assert.throws(() => {
    sanitizeForCloud(hugeDoc);
  }, /exceeds maximum limit/);
});

test('13. Prototype pollution protection', () => {
  const pollutedPayload = JSON.parse('{"__proto__":{"polluted":true},"answers":{"q1":{"attempts":1}}}');
  const clean = sanitizeForCloud(pollutedPayload);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(clean.polluted, undefined);
});

test('14. stateToDocument handles state conversion with tombstones', () => {
  const baseline = createBlankDocument('dev1');
  baseline.favorites['fav1'] = { active: true, updatedAt: 1000 };
  baseline.wrong['wrg1'] = { active: true, updatedAt: 1000 };

  const localState = {
    version: 1,
    answers: { 'q1': { attempts: 2, correct: 1, last: 'A' } },
    wrong: [], // wrg1 removed
    favorites: ['fav2'], // fav1 removed, fav2 added
    levels: { 'h-1-0': { passed: true, score: 100 } },
    days: ['2026-11-02'],
    drafts: { 'u1': 'void test() {}' },
    selfChecks: {}
  };

  const doc = stateToDocument(localState, baseline, { deviceId: 'dev1', now: 2000 });
  assert.strictEqual(doc.favorites['fav1'].active, false, 'Removed favorite gets tombstone');
  assert.strictEqual(doc.favorites['fav2'].active, true, 'New favorite is active');
  assert.strictEqual(doc.wrong['wrg1'].active, false, 'Removed wrong gets tombstone');
  assert.strictEqual(doc.answers['q1'].attempts, 2);
  assert.strictEqual(doc.levels['h-1-0'].passed, true);
});

test('15. Multiple drafts conflict deduplication and resolution', () => {
  const docA = createBlankDocument('devA');
  docA.drafts['u1'] = {
    text: 'v3',
    updatedAt: 3000,
    conflicts: [
      { text: 'v1', updatedAt: 1000, deviceId: 'devA' },
      { text: 'v2', updatedAt: 2000, deviceId: 'devB' }
    ]
  };

  const docB = createBlankDocument('devB');
  docB.drafts['u1'] = {
    text: 'v4',
    updatedAt: 4000,
    conflicts: [
      { text: 'v2', updatedAt: 2000, deviceId: 'devB' }
    ]
  };

  const merged = mergeProgress(docA, docB, { now: 5000 });
  assert.strictEqual(merged.drafts['u1'].text, 'v4', 'v4 is newer so primary');
  // conflicts should contain v3, v1, v2 without duplicate v2
  const conflictTexts = merged.drafts['u1'].conflicts.map(c => c.text);
  assert.ok(conflictTexts.includes('v3'));
  assert.ok(conflictTexts.includes('v1'));
  assert.ok(conflictTexts.includes('v2'));
  assert.strictEqual(conflictTexts.filter(t => t === 'v2').length, 1, 'Duplicate conflicts must be deduped');
});

test('16. Answers last-option resolves to newer timestamp', () => {
  const docA = createBlankDocument('devA');
  docA.answers['q1'] = { attempts: 1, correct: 0, last: 'A', updatedAt: 1000, devices: { devA: { attempts: 1, correct: 0 } } };

  const docB = createBlankDocument('devB');
  docB.answers['q1'] = { attempts: 1, correct: 1, last: 'C', updatedAt: 2000, devices: { devB: { attempts: 1, correct: 1 } } };

  const merged = mergeProgress(docA, docB, { now: 3000 });
  assert.strictEqual(merged.answers['q1'].last, 'C', 'Last answer from newer timestamp wins');
  assert.strictEqual(merged.answers['q1'].attempts, 2);
  assert.strictEqual(merged.answers['q1'].correct, 1);
});

console.log(`\nAll ${testCount} tests passed successfully in test_sync.cjs!`);
