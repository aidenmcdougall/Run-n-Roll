import { setWorkerUrl } from 'maplibre-gl';
// MapLibre 6 computes its worker URL at runtime, which bundlers can't see.
// `?worker&url` makes Vite bundle the worker (with its shared chunk) as a
// standalone ES module and gives us its URL, in both dev and production.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
