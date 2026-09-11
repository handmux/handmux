import { AsyncLocalStorage } from 'node:async_hooks';

// Carry the HTTP authorization through awaited queues to the actual side-effect edge.
// No context means an internal/background operation; token mode remains unchanged.
const authority = new AsyncLocalStorage<() => void>();
export function withRequestAuthority<T>(check: () => void, operation: () => T): T {
  return authority.run(check, operation);
}
export function assertRequestAuthority(): void { authority.getStore()?.(); }
