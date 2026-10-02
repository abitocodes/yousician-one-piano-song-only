// Persistent state: settings (localStorage), song library (IndexedDB with in-memory fallback), score book.
// Importable in Node: browser globals are only touched lazily and always behind feature checks.

import { Emitter } from './emitter.js';
import { normalizeSong } from './song.js';
import { BUILTIN_SONGS } from '../data/demo-songs.js';

export const SETTINGS_KEY = 'pk.settings';
export const SCORES_KEY = 'pk.scores';
export const DB_NAME = 'piano-karaoke';
export const DB_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  inputMode: 'mic',
  latency: 0.10,
  sensitivity: 0.6,
  octaveTolerant: true,
  a4: 440,
  difficulty: 'normal',
  speed: 1,
  lookahead: 2.5,
  labelStyle: 'solfege',
  showLyrics: true,
  guideMelody: false,
  metronome: false,
  masterVolume: 0.8,
  backingVolume: 0.8,
  keepAwake: true,
  showDetected: true,
});

export const SETTING_SCHEMA = Object.freeze({
  inputMode: { type: 'enum', values: ['mic', 'touch', 'sim'] },
  latency: { type: 'number', min: -0.1, max: 0.5, step: 0.001 },
  sensitivity: { type: 'number', min: 0, max: 1, step: 0.01 },
  octaveTolerant: { type: 'bool' },
  a4: { type: 'number', min: 415, max: 466, step: 0.1 },
  difficulty: { type: 'enum', values: ['easy', 'normal', 'hard'] },
  speed: { type: 'number', min: 0.5, max: 1.25, step: 0.05 },
  lookahead: { type: 'number', min: 1.2, max: 5, step: 0.1 },
  labelStyle: { type: 'enum', values: ['solfege', 'en', 'none'] },
  showLyrics: { type: 'bool' },
  guideMelody: { type: 'bool' },
  metronome: { type: 'bool' },
  masterVolume: { type: 'number', min: 0, max: 1, step: 0.01 },
  backingVolume: { type: 'number', min: 0, max: 1, step: 0.01 },
  keepAwake: { type: 'bool' },
  showDetected: { type: 'bool' },
});

// ---------------------------------------------------------------- key/value storage helpers

/** Map-backed object with the Web Storage API surface (used in Node, private mode, or when storage throws). */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

let sharedStorage = null;

/** localStorage when it is usable, otherwise a process-wide in-memory replacement. */
export function safeLocalStorage() {
  if (sharedStorage) return sharedStorage;
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = '__pk_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      sharedStorage = ls;
      return ls;
    }
  } catch { /* unavailable */ }
  sharedStorage = memoryStorage();
  return sharedStorage;
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------- settings

function stepDecimals(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** → { ok, value }. Numbers are clamped and snapped to the step; enums/booleans must be valid. */
export function validateSetting(key, value) {
  const rule = SETTING_SCHEMA[key];
  if (!rule) return { ok: false, value: undefined };
  if (rule.type === 'enum') {
    return rule.values.includes(value) ? { ok: true, value } : { ok: false, value: DEFAULT_SETTINGS[key] };
  }
  if (rule.type === 'bool') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 1 || value === '1') return { ok: true, value: true };
    if (value === 'false' || value === 0 || value === '0') return { ok: true, value: false };
    return { ok: false, value: DEFAULT_SETTINGS[key] };
  }
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, value: DEFAULT_SETTINGS[key] };
  let v = Math.min(rule.max, Math.max(rule.min, n));
  if (rule.step) {
    v = Number((Math.round(v / rule.step) * rule.step).toFixed(stepDecimals(rule.step)));
    v = Math.min(rule.max, Math.max(rule.min, v));
  }
  return { ok: true, value: v };
}

export class Settings extends Emitter {
  /**
   * @param overrides session-only values (e.g. { inputMode: 'sim' } from ?input=), never persisted.
   * @param options.storage Web Storage compatible object (defaults to localStorage or memory).
   */
  constructor(overrides = {}, { storage = safeLocalStorage(), key = SETTINGS_KEY } = {}) {
    super();
    this._storage = storage;
    this._key = key;
    this._values = { ...DEFAULT_SETTINGS };
    this._overrides = {};
    const stored = readJson(storage, key);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!(k in stored)) continue;
        const r = validateSetting(k, stored[k]);
        if (r.ok) this._values[k] = r.value;
      }
    }
    for (const [k, v] of Object.entries(overrides || {})) {
      const r = validateSetting(k, v);
      if (r.ok) this._overrides[k] = r.value;
    }
  }

  get(k) {
    if (Object.prototype.hasOwnProperty.call(this._overrides, k)) return this._overrides[k];
    return this._values[k];
  }

  /** Validates, persists and emits 'change'(key, value). Setting an overridden key drops the session override. */
  set(k, v) {
    const r = validateSetting(k, v);
    if (!r.ok) return false;
    const before = this.get(k);
    delete this._overrides[k];
    this._values[k] = r.value;
    this._save();
    if (before !== r.value) this.emit('change', k, r.value);
    return true;
  }

  update(obj) {
    let changed = 0;
    for (const [k, v] of Object.entries(obj || {})) {
      const before = this.get(k);
      if (this.set(k, v) && this.get(k) !== before) changed++;
    }
    return changed;
  }

  all() {
    return { ...this._values, ...this._overrides };
  }

  isOverridden(k) {
    return Object.prototype.hasOwnProperty.call(this._overrides, k);
  }

  reset() {
    const before = this.all();
    this._values = { ...DEFAULT_SETTINGS };
    this._overrides = {};
    this._save();
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (before[k] !== this._values[k]) this.emit('change', k, this._values[k]);
    }
  }

  _save() {
    writeJson(this._storage, this._key, this._values);
  }
}

// ---------------------------------------------------------------- IndexedDB helpers

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 요청 실패'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 트랜잭션 실패'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 트랜잭션 중단'));
  });
}

function openDb(idb, name, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timeout'));
    }, timeoutMs);
    try {
      req = idb.open(name, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error || new Error('IndexedDB open failed'));
    };
  });
}

function makeSongId() {
  return `song-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------- library

export class Library extends Emitter {
  constructor({ builtins = BUILTIN_SONGS, indexedDB: idb, dbName = DB_NAME } = {}) {
    super();
    this._builtins = Array.from(builtins || []);
    this._builtinIds = new Set(this._builtins.map((s) => s.id));
    this._idb = idb === undefined ? globalThis.indexedDB : idb;
    this._dbName = dbName;
    this._db = null;
    this._songs = new Map();
    this._memAudio = new Map();
    this._initP = null;
    this._lastStamp = 0;
  }

  /** true when songs survive a reload (IndexedDB available). */
  get persistent() {
    return !!this._db;
  }

  init() {
    if (!this._initP) this._initP = this._init();
    return this._initP;
  }

  async _init() {
    if (this._idb) {
      try {
        this._db = await openDb(this._idb, this._dbName);
        const tx = this._db.transaction('songs', 'readonly');
        const rows = await reqP(tx.objectStore('songs').getAll());
        for (const raw of rows || []) {
          const song = this._sanitizeStored(raw);
          if (song) {
            this._songs.set(song.id, song);
            this._lastStamp = Math.max(this._lastStamp, song.updatedAt || 0);
          }
        }
      } catch (err) {
        console.warn('[storage] IndexedDB를 사용할 수 없어 메모리에 저장합니다.', err);
        try { this._db?.close(); } catch { /* ignore */ }
        this._db = null;
      }
    }
    return this;
  }

  _sanitizeStored(raw) {
    try {
      const song = normalizeSong(raw);
      if (!song || typeof song.id !== 'string' || !song.id) return null;
      song.builtin = false;
      song.template = false;
      return song;
    } catch (err) {
      console.warn('[storage] 손상된 곡을 건너뜁니다.', err);
      return null;
    }
  }

  isBuiltin(id) {
    return this._builtinIds.has(id);
  }

  /** true when a user song replaces the builtin with this id. */
  hasOverride(id) {
    return this._builtinIds.has(id) && this._songs.has(id);
  }

  async list() {
    await this.init();
    const out = [];
    for (const b of this._builtins) out.push(clone(this._songs.get(b.id) || b));
    const users = Array.from(this._songs.values())
      .filter((s) => !this._builtinIds.has(s.id))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const s of users) out.push(clone(s));
    return out;
  }

  /** All songs stored by the user (including overrides of builtins), newest first. */
  async userSongs() {
    await this.init();
    return Array.from(this._songs.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(clone);
  }

  async get(id) {
    await this.init();
    if (id == null) return null;
    const user = this._songs.get(id);
    if (user) return clone(user);
    const builtin = this._builtins.find((s) => s.id === id);
    return builtin ? clone(builtin) : null;
  }

  async save(song) {
    await this.init();
    const s = normalizeSong(song);
    if (!s.id || typeof s.id !== 'string') s.id = makeSongId();
    const now = Date.now();
    s.builtin = false;
    s.template = false;
    // Strictly increasing stamps keep "most recently saved first" ordering stable even within one millisecond.
    s.updatedAt = Math.max(now, this._lastStamp + 1);
    this._lastStamp = s.updatedAt;
    if (!Number.isFinite(s.createdAt) || s.createdAt <= 0) s.createdAt = now;
    if (this._db) {
      try {
        const tx = this._db.transaction('songs', 'readwrite');
        tx.objectStore('songs').put(s);
        await txDone(tx);
      } catch (err) {
        console.error(err);
        throw new Error('곡을 저장하지 못했어요. 저장 공간이 부족하지 않은지 확인해 주세요.');
      }
    }
    this._songs.set(s.id, s);
    this.emit('change', { type: 'save', id: s.id });
    return clone(s);
  }

  async remove(id) {
    await this.init();
    if (this._db) {
      const tx = this._db.transaction(['songs', 'audio'], 'readwrite');
      tx.objectStore('songs').delete(id);
      tx.objectStore('audio').delete(id);
      await txDone(tx);
    }
    this._memAudio.delete(id);
    const existed = this._songs.delete(id);
    this.emit('change', { type: 'remove', id });
    return existed;
  }

  async saveAudio(id, blob) {
    await this.init();
    if (!(blob instanceof Blob)) throw new Error('음원 파일이 올바르지 않아요.');
    if (!this._db) {
      this._memAudio.set(id, blob);
      return;
    }
    try {
      const tx = this._db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put(blob, id);
      await txDone(tx);
    } catch (err) {
      // Some engines cannot store Blobs directly; fall back to raw bytes.
      try {
        const record = { type: blob.type || 'application/octet-stream', data: await blob.arrayBuffer() };
        const tx = this._db.transaction('audio', 'readwrite');
        tx.objectStore('audio').put(record, id);
        await txDone(tx);
      } catch (err2) {
        console.error(err, err2);
        throw new Error('반주 음원을 저장하지 못했어요. 파일이 너무 크거나 저장 공간이 부족해요.');
      }
    }
  }

  async getAudio(id) {
    await this.init();
    if (!this._db) return this._memAudio.get(id) || null;
    try {
      const tx = this._db.transaction('audio', 'readonly');
      const rec = await reqP(tx.objectStore('audio').get(id));
      if (!rec) return null;
      if (rec instanceof Blob) return rec;
      if (rec.data) return new Blob([rec.data], { type: rec.type || '' });
      return null;
    } catch (err) {
      console.warn('[storage] 음원을 불러오지 못했어요.', err);
      return null;
    }
  }

  async removeAudio(id) {
    await this.init();
    this._memAudio.delete(id);
    if (!this._db) return;
    const tx = this._db.transaction('audio', 'readwrite');
    tx.objectStore('audio').delete(id);
    await txDone(tx);
  }
}

// ---------------------------------------------------------------- scores

export class ScoreBook {
  constructor({ storage = safeLocalStorage(), key = SCORES_KEY } = {}) {
    this._storage = storage;
    this._key = key;
    const data = readJson(storage, key);
    this._data = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  get(songId) {
    const e = this._data[songId];
    if (!e || typeof e !== 'object') return { best: null, plays: 0 };
    const b = e.best;
    const best = b && Number.isFinite(b.score)
      ? { score: b.score, accuracy: Number(b.accuracy) || 0, rank: String(b.rank || 'D'), date: Number(b.date) || 0 }
      : null;
    return { best, plays: Number.isFinite(e.plays) ? e.plays : 0 };
  }

  /** Records a finished run. Only mode 'play' can set a new best. → { isBest, previousBest } */
  record(songId, stats, mode = 'play') {
    const cur = this.get(songId);
    const previousBest = cur.best ? { ...cur.best } : null;
    const score = Number(stats?.score);
    const valid = Number.isFinite(score) && (stats?.total ?? 1) > 0;
    let isBest = false;
    let best = cur.best;
    if (mode === 'play' && valid && score > 0 && (!previousBest || score > previousBest.score)) {
      isBest = true;
      best = {
        score: Math.round(score),
        accuracy: Number(stats.accuracy) || 0,
        rank: String(stats.rank || 'D'),
        date: Date.now(),
      };
    }
    this._data[songId] = { best, plays: cur.plays + 1 };
    writeJson(this._storage, this._key, this._data);
    return { isBest, previousBest };
  }

  remove(songId) {
    delete this._data[songId];
    writeJson(this._storage, this._key, this._data);
  }

  clear() {
    this._data = {};
    writeJson(this._storage, this._key, this._data);
  }
}
