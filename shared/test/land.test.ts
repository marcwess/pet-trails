import assert from 'node:assert/strict';
import test from 'node:test';
import { LandBook, multiContains } from '../src/land.ts';

test('union merges overlapping rectangles and area stays exact', () => {
  const book = new LandBook(4, 40, 40);
  book.unionRect(1, 0, 0, 4, 4);
  book.unionRect(1, 2, 2, 4, 4);
  assert.ok(Math.abs(book.areaOf(1) - 28) < 0.05, `area ${book.areaOf(1)}`);
  assert.equal(book.contains(1, 1, 1), true);
  assert.equal(book.contains(1, 5, 5), true);
  assert.equal(book.contains(1, 3, 3), true);
  assert.equal(book.contains(1, 8, 8), false);
  assert.ok(book.vertsOf(1) <= 12);
});

test('subtract steals only the overlap', () => {
  const book = new LandBook(4, 40, 40);
  book.unionRect(1, 0, 0, 10, 6);
  book.unionRect(2, 6, 0, 10, 6);
  const before = book.areaOf(2);
  // A loop that bites the left half of owner 2.
  const xs = [10, 14, 14, 10];
  const ys = [0, 0, 6, 6];
  // Close by claiming a rectangle via union on 1 and difference through prepare.
  const trailX = [10, 14, 14, 10, 10];
  const trailY = [-1, -1, 7, 7, -1];
  // Owner 1's land touches y=0..6, x=0..10. Trail runs outside along the top.
  assert.equal(book.prepareClaim(1, trailX, trailY, trailX.length), true);
  const gained = book.commitClaim(1);
  assert.ok(gained > 1, `gained ${gained}`);
  assert.ok(book.areaOf(2) < before - 1, `stolen area ${book.areaOf(2)} from ${before}`);
  assert.equal(book.contains(1, 12, 3), true);
  assert.equal(book.contains(2, 12, 3), false);
  assert.equal(book.contains(2, 15.5, 3), true);
  assert.ok(book.audit());
  void xs;
  void ys;
});

test('quantized polygons round-trip', () => {
  const book = new LandBook(4, 80, 80);
  book.unionRect(1, 10, 12, 18, 18);
  const wire = book.encodeAll();
  const other = new LandBook(4, 80, 80);
  other.applyEncoded(wire);
  assert.ok(Math.abs(other.areaOf(1) - 18 * 18) < 0.05);
  assert.equal(other.contains(1, 19, 21), true);
  assert.equal(other.contains(1, 9, 12), false);
  const cleared = new LandBook(4, 80, 80);
  cleared.unionRect(1, 1, 1, 4, 4);
  cleared.clear(1);
  const patch = cleared.encode(cleared.changedIds());
  other.applyEncoded(patch);
  assert.equal(other.areaOf(1), 0);
  assert.equal(other.contains(1, 19, 21), false);
});

test('a point in a hole is not owned', () => {
  const holed = [
    [
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0],
      ],
      [
        [6, 6],
        [6, 10],
        [10, 10],
        [10, 6],
        [6, 6],
      ],
    ],
  ] as const;
  assert.equal(multiContains(holed as unknown as Parameters<typeof multiContains>[0], 2, 2), true);
  assert.equal(multiContains(holed as unknown as Parameters<typeof multiContains>[0], 8, 8), false);
  const book = new LandBook(2, 30, 30);
  book.unionRect(1, 0, 0, 20, 20);
  book.unionRect(2, 22, 6, 4, 4);
  const xs = [26, 26, 8, 8, 14, 14, 26];
  const ys = [8, 14, 14, 6, 6, 12, 12];
  assert.equal(book.prepareClaim(2, xs, ys, xs.length), true);
  book.commitClaim(2);
  assert.equal(book.contains(1, 2, 10), true);
  assert.equal(book.contains(2, 11, 9), true);
  assert.equal(book.contains(1, 11, 9), false);
  assert.equal(book.audit(), true);
});
