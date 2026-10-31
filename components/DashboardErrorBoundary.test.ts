// Frozen test: DashboardErrorBoundary must recover from a render error on its
// own. The kiosk's 30s poll lives inside the boundary's children, so a
// boundary that stays in the fallback forever also stops polling forever.
//
// Drives the real class through the same lifecycle React uses:
// getDerivedStateFromError -> componentDidCatch -> render, with node:test's
// mocked setTimeout/clearTimeout. `react` is resolved to a minimal in-memory
// Component base (setState is replaced per instance below), so the test does
// not need node_modules.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

const REACT_STUB = [
  'export class Component { constructor(props) { this.props = props; } setState() { throw new Error("setState not stubbed"); } }',
  'export default { Component };',
].join('\n');
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    if (specifier === 'react') return { url: 'stub:react', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url: string, context: any, nextLoad: any) {
    if (url === 'stub:react') return { format: 'module', source: REACT_STUB, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { DashboardErrorBoundary } = await import('./DashboardErrorBoundary.ts');

const RESET_MS = 30_000;

type Boundary = InstanceType<typeof DashboardErrorBoundary>;

function mount(onError?: (e: Error, i: unknown) => void) {
  const b = new DashboardErrorBoundary({ children: 'CHILDREN', fallback: 'FALLBACK', onError } as any) as Boundary;
  const updates: unknown[] = [];
  // Stand-in for React's updater: apply the partial state (object or updater fn).
  (b as any).setState = (partial: any) => {
    const next = typeof partial === 'function' ? partial(b.state, b.props) : partial;
    updates.push(next);
    if (next) (b as any).state = { ...b.state, ...next };
  };
  return { b, updates };
}

// What React does when a child throws during render.
function throwInChild(b: Boundary, err = new Error('boom')) {
  const derived = (DashboardErrorBoundary as any).getDerivedStateFromError(err);
  (b as any).state = { ...b.state, ...derived };
  b.componentDidCatch(err, { componentStack: '\n    at Inner' } as any);
}

function withTimers(fn: () => void) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try { fn(); } finally { mock.timers.reset(); }
}

test('fallback after a child throws, children again once the 30s reset fires', () => withTimers(() => {
  const seen: string[] = [];
  const { b } = mount((e) => seen.push(e.message));
  assert.equal(b.render(), 'CHILDREN');
  throwInChild(b, new Error('render blew up'));
  assert.deepEqual(seen, ['render blew up'], 'onError still reports the render error');
  assert.equal(b.render(), 'FALLBACK');
  mock.timers.tick(RESET_MS - 1);
  assert.equal(b.render(), 'FALLBACK', 'must not reset before 30s');
  mock.timers.tick(1);
  assert.equal(b.state.hasError, false);
  assert.equal(b.render(), 'CHILDREN', 'children (and their poll) must be mounted again after 30s');
}));

test('recovers again after a second, later render error', () => withTimers(() => {
  const { b } = mount();
  throwInChild(b);
  mock.timers.tick(RESET_MS);
  assert.equal(b.render(), 'CHILDREN');
  throwInChild(b);
  assert.equal(b.render(), 'FALLBACK');
  mock.timers.tick(RESET_MS);
  assert.equal(b.render(), 'CHILDREN', 'a second failure must also self-heal');
}));

test('pending reset is cleared on unmount (no setState after unmount)', () => withTimers(() => {
  const a = mount();
  throwInChild(a.b);
  a.b.componentWillUnmount?.();
  mock.timers.tick(RESET_MS * 3);
  assert.deepEqual(a.updates, [], 'no setState may fire on an unmounted boundary');
  // positive control: the same sequence without unmount does reset
  const c = mount();
  throwInChild(c.b);
  mock.timers.tick(RESET_MS);
  assert.equal(c.updates.length, 1);
  assert.equal(c.b.render(), 'CHILDREN');
}));

test('repeated catches before the reset schedule exactly one reset', () => withTimers(() => {
  const { b, updates } = mount();
  throwInChild(b);
  mock.timers.tick(10_000);
  throwInChild(b);
  throwInChild(b);
  mock.timers.tick(RESET_MS * 4);
  assert.equal(updates.length, 1, 'one pending timer at a time');
  assert.deepEqual(updates[0], { hasError: false });
  assert.equal(b.render(), 'CHILDREN');
}));
