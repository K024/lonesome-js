import { reduce } from './lib/reducer.ts';
import { runEffect } from './lib/effects.ts';
import type { AppState, AppEvent } from './lib/types.ts';

const configArg = Deno.args.find((a) => a.startsWith('config='));
const configPath = configArg
  ? configArg.slice('config='.length)
  : import.meta.dirname + '/config.json';

let state: AppState = {
  config: null,
  server: null,
  workers: new Map(),
  readyWorkers: new Set(),
  workerRoutes: new Map(),
  watcher: null,
};

async function dispatch(event: AppEvent): Promise<void> {
  const [nextState, effects] = reduce(state, event);
  // Mutate in-place so closures see the updated state
  Object.assign(state, nextState);

  for (const effect of effects) {
    await runEffect(effect, dispatch, state);
  }

  if (event.type === 'Shutdown' && state.workers.size === 0) {
    Deno.exit(0);
  }
}

async function shutdown() {
  await dispatch({ type: 'Shutdown' });
  setTimeout(() => Deno.exit(0), 500);
}

Deno.addSignalListener('SIGINT', shutdown);
Deno.addSignalListener('SIGTERM', shutdown);

await dispatch({ type: 'Init', configPath });
await new Promise(() => {});
