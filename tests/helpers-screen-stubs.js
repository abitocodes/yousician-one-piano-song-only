// Lets node:test import screen modules (editor.js / calibrate.js / play.js / home.js / results.js) for their pure helpers.
// Browser-only dependencies (DOM helpers, Web Audio engine, synth) are replaced by inert stubs through a
// module resolution hook, so the tests neither need a DOM nor depend on those files existing.
import { register } from 'node:module';

const STUBS = {
  '/js/ui/dom.js': `
    const noop = () => {};
    export const $ = () => null;
    export const $$ = () => [];
    export const h = () => ({});
    export const syncRange = noop;
    export const toast = () => ({ close: noop });
    export const modal = () => ({ close: noop, el: null });
    export const confirmDialog = async () => false;
    export const downloadFile = noop;
    export const pickFile = async () => null;
    export const formatTime = (s) => String(s);
    export const formatNumber = (n) => String(Math.round(n));
    export const listen = () => noop;
    export const escapeHtml = (s) => String(s);
  `,
  '/js/audio/engine.js': `
    export const getAudioContext = () => ({ currentTime: 0 });
    export const unlockAudio = async () => ({ currentTime: 0 });
    export const audioNow = () => 0;
    export const masterOut = () => null;
    export const setMasterVolume = () => {};
  `,
  '/js/audio/synth.js': `
    export class Synth {
      playNote() { return { stop() {} }; }
      click() { return { stop() {} }; }
      sfx() {}
      stopAll() {}
      setVolume() {}
    }
  `,
};

const hooks = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  if (context.parentURL && (specifier.startsWith('.') || specifier.startsWith('/'))) {
    let url;
    try { url = new URL(specifier, context.parentURL); } catch { url = null; }
    if (url && url.protocol === 'file:') {
      for (const [suffix, src] of Object.entries(STUBS)) {
        if (url.pathname.endsWith(suffix)) {
          return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
        }
      }
    }
  }
  return next(specifier, context);
}
`;

let registered = false;

export async function importScreen(relPath) {
  if (!registered) {
    register(`data:text/javascript,${encodeURIComponent(hooks)}`);
    registered = true;
  }
  return import(new URL(relPath, import.meta.url).href);
}
