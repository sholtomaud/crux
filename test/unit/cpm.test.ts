/**
 * test/unit/cpm.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort, computeCpm, asciiDag, dotGraph } from '../../lib/cpm.ts';
import type { CpmNode, CpmEdge } from '../../lib/cpm.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function n(id: number, slug: string, duration: number, title = slug): CpmNode {
  return { id, slug, title, duration };
}

function e(pred: number, succ: number): CpmEdge {
  return { predecessor_id: pred, successor_id: succ };
}

// ── topoSort ──────────────────────────────────────────────────────────────────

describe('topoSort', () => {
  test('empty graph', () => {
    assert.deepEqual(topoSort([], []), []);
  });

  test('single node', () => {
    assert.deepEqual(topoSort([n(1, 'a', 1)], []), [1]);
  });

  test('linear chain a→b→c', () => {
    const nodes = [n(1, 'a', 1), n(2, 'b', 1), n(3, 'c', 1)];
    const edges = [e(1, 2), e(2, 3)];
    const order = topoSort(nodes, edges);
    // a must precede b, b must precede c
    assert.ok(order.indexOf(1) < order.indexOf(2));
    assert.ok(order.indexOf(2) < order.indexOf(3));
  });

  test('diamond a→b,c→d', () => {
    const nodes = [n(1,'a',1), n(2,'b',1), n(3,'c',1), n(4,'d',1)];
    const edges = [e(1,2), e(1,3), e(2,4), e(3,4)];
    const order = topoSort(nodes, edges);
    assert.ok(order.indexOf(1) < order.indexOf(2));
    assert.ok(order.indexOf(1) < order.indexOf(3));
    assert.ok(order.indexOf(2) < order.indexOf(4));
    assert.ok(order.indexOf(3) < order.indexOf(4));
  });

  test('cycle throws', () => {
    const nodes = [n(1,'a',1), n(2,'b',1)];
    const edges = [e(1,2), e(2,1)];
    assert.throws(() => topoSort(nodes, edges), /Cycle detected/);
  });
});

// ── computeCpm ────────────────────────────────────────────────────────────────

describe('computeCpm', () => {
  test('empty graph', () => {
    const result = computeCpm([], []);
    assert.equal(result.project_duration, 0);
    assert.equal(result.nodes.length, 0);
    assert.equal(result.critical_path.length, 0);
  });

  test('single task', () => {
    const result = computeCpm([n(1, 'a', 5)], []);
    assert.equal(result.project_duration, 5);
    const node = result.nodes[0];
    assert.equal(node.early_start, 0);
    assert.equal(node.early_finish, 5);
    assert.equal(node.late_start, 0);
    assert.equal(node.late_finish, 5);
    assert.equal(node.float_days, 0);
    assert.equal(node.is_critical, true);
  });

  test('linear chain: a(3)→b(4)→c(2) — total 9, all critical', () => {
    const nodes = [n(1,'a',3), n(2,'b',4), n(3,'c',2)];
    const edges = [e(1,2), e(2,3)];
    const result = computeCpm(nodes, edges);
    assert.equal(result.project_duration, 9);
    for (const node of result.nodes) {
      assert.equal(node.float_days, 0, `${node.slug} should have 0 float`);
      assert.equal(node.is_critical, true);
    }
    assert.deepEqual(result.critical_path, ['a', 'b', 'c']);
  });

  test('parallel paths — critical is the longer one', () => {
    // a(1)→b(5)→d(1)   duration = 7  ← critical
    // a(1)→c(2)→d(1)   duration = 4
    const nodes = [n(1,'a',1), n(2,'b',5), n(3,'c',2), n(4,'d',1)];
    const edges = [e(1,2), e(1,3), e(2,4), e(3,4)];
    const result = computeCpm(nodes, edges);
    assert.equal(result.project_duration, 7);

    const bySlug = Object.fromEntries(result.nodes.map(nd => [nd.slug, nd]));
    assert.equal(bySlug['a'].is_critical, true);
    assert.equal(bySlug['b'].is_critical, true);
    assert.equal(bySlug['d'].is_critical, true);
    assert.equal(bySlug['c'].is_critical, false);
    assert.ok(bySlug['c'].float_days > 0, 'c should have positive float');
  });

  test('parallel paths — float on non-critical', () => {
    // a(1)→b(5)→d(1)   ES/EF: a=0-1, b=1-6, d=6-7
    // a(1)→c(2)→d(1)                  c=1-3   float=3
    const nodes = [n(1,'a',1), n(2,'b',5), n(3,'c',2), n(4,'d',1)];
    const edges = [e(1,2), e(1,3), e(2,4), e(3,4)];
    const result = computeCpm(nodes, edges);
    const c = result.nodes.find(nd => nd.slug === 'c')!;
    assert.equal(c.float_days, 3);
  });

  test('diamond: all critical when both paths equal length', () => {
    // a(2)→b(3)→d(2)  and  a(2)→c(3)→d(2)  → duration 7, all critical
    const nodes = [n(1,'a',2), n(2,'b',3), n(3,'c',3), n(4,'d',2)];
    const edges = [e(1,2), e(1,3), e(2,4), e(3,4)];
    const result = computeCpm(nodes, edges);
    assert.equal(result.project_duration, 7);
    for (const nd of result.nodes) {
      assert.equal(nd.is_critical, true, `${nd.slug} should be critical`);
    }
  });

  test('cycle in task graph throws', () => {
    const nodes = [n(1,'a',1), n(2,'b',1)];
    const edges  = [e(1,2), e(2,1)];
    assert.throws(() => computeCpm(nodes, edges), /Cycle detected/);
  });

  test('task with duration 0 does not cause negative float', () => {
    const nodes = [n(1,'a',0), n(2,'b',3)];
    const edges = [e(1,2)];
    const result = computeCpm(nodes, edges);
    assert.ok(result.nodes.every(nd => nd.float_days >= 0));
  });
});

// ── asciiDag ──────────────────────────────────────────────────────────────────

describe('asciiDag', () => {
  test('empty returns placeholder', () => {
    assert.equal(asciiDag([], []), '(no tasks)');
  });

  test('single node', () => {
    const out = asciiDag([n(1,'setup',2)], []);
    assert.ok(out.includes('setup'));
  });

  test('chain shows arrows', () => {
    const nodes = [n(1,'a',1), n(2,'b',1)];
    const out = asciiDag(nodes, [e(1,2)]);
    assert.ok(out.includes('→'));
    assert.ok(out.includes('b'));
  });
});

// ── dotGraph ──────────────────────────────────────────────────────────────────

describe('dotGraph', () => {
  test('produces valid DOT header', () => {
    const out = dotGraph([n(1,'a',1)], []);
    assert.ok(out.startsWith('digraph crux {'));
    assert.ok(out.includes('"a"'));
  });

  test('critical nodes get fill colour', () => {
    const nodes = [n(1,'a',3)];
    const cpmResult = computeCpm(nodes, []);
    const out = dotGraph(nodes, [], cpmResult.nodes);
    assert.ok(out.includes('filled'));
  });
});
