// Frozen test: DashboardErrorBoundary exposes how many automatic retries have
// happened so the kiosk fallback can show a truthful "retry #n" line.
// `fallback` may be a function (retries: number) => ReactNode. The count is the
// number of auto-resets that have fired so far (0 while waiting for the first).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';

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

function mount(fallback: unknown) {
  const b: any = new (DashboardErrorBoundary as any)({ children: 'CHILDREN', fallback });
  b.setState = (partial: any) => {
    const next = typeof partial === 'function' ? partial(b.state, b.props) : partial;
    if (next) b.state = { ...b.state, ...next };
  };
  return b;
}

function throwInChild(b: any) {
  const err = new Error('boom');
  b.state = { ...b.state, ...(DashboardErrorBoundary as any).getDerivedStateFromError(err) };
  b.componentDidCatch(err, { componentStack: '\n    at Inner' });
}

function withTimers(fn: () => void) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try { fn(); } finally { mock.timers.reset(); }
}

const fb = (n: number) => 'FALLBACK#' + n;

test('function fallback gets 0 retries while waiting for the first reset', () => withTimers(() => {
  const b = mount(fb);
  assert.equal(b.render(), 'CHILDREN');
  throwInChild(b);
  assert.equal(b.render(), 'FALLBACK#0');
  mock.timers.tick(RESET_MS - 1);
  assert.equal(b.render(), 'FALLBACK#0', 'still waiting, still zero retries');
}));

test('each auto-reset that fires and fails again raises the count by one', () => withTimers(() => {
  const b = mount(fb);
  throwInChild(b);
  mock.timers.tick(RESET_MS);
  assert.equal(b.render(), 'CHILDREN');
  throwInChild(b);
  assert.equal(b.render(), 'FALLBACK#1');
  mock.timers.tick(RESET_MS);
  throwInChild(b);
  assert.equal(b.render(), 'FALLBACK#2');
}));

test('an unmounted boundary never counts a retry', () => withTimers(() => {
  const b = mount(fb);
  throwInChild(b);
  b.componentWillUnmount();
  mock.timers.tick(RESET_MS * 3);
  assert.equal(b.render(), 'FALLBACK#0');
}));

test('a static ReactNode fallback is still rendered as-is', () => withTimers(() => {
  const b = mount('STATIC');
  throwInChild(b);
  assert.equal(b.render(), 'STATIC');
  mock.timers.tick(RESET_MS);
  assert.equal(b.render(), 'CHILDREN');
  throwInChild(b);
  assert.equal(b.render(), 'STATIC');
}));

test('the props type advertises the function fallback (typecheck contract for the pages)', () => {
  const src = readFileSync(new URL('./DashboardErrorBoundary.ts', import.meta.url), 'utf8');
  assert.match(src, /fallback:\s*ReactNode\s*\|\s*\(\(retries: number\) => ReactNode\)/);
});
