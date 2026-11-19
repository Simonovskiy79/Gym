'use strict';

/* ================== Данные ================== */

const STORAGE_KEY = 'gym-tracker-v1';

const GROUPS = ['Грудь', 'Спина', 'Ноги', 'Плечи', 'Руки', 'Пресс', 'Кардио', 'Другое'];

const DEFAULT_EXERCISES = [
  ['Жим штанги лёжа', 'Грудь'], ['Жим гантелей на наклонной', 'Грудь'], ['Разводка гантелей', 'Грудь'], ['Отжимания на брусьях', 'Грудь'],
  ['Подтягивания', 'Спина'], ['Тяга штанги в наклоне', 'Спина'], ['Тяга верхнего блока', 'Спина'], ['Тяга горизонтального блока', 'Спина'], ['Становая тяга', 'Спина'],
  ['Приседания со штангой', 'Ноги'], ['Жим ногами', 'Ноги'], ['Румынская тяга', 'Ноги'], ['Выпады', 'Ноги'], ['Разгибание ног', 'Ноги'], ['Сгибание ног', 'Ноги'], ['Подъём на носки', 'Ноги'],
  ['Жим штанги стоя', 'Плечи'], ['Жим гантелей сидя', 'Плечи'], ['Махи гантелями в стороны', 'Плечи'],
  ['Подъём штанги на бицепс', 'Руки'], ['Молотки', 'Руки'], ['Французский жим', 'Руки'], ['Разгибание на блоке', 'Руки'],
  ['Скручивания', 'Пресс'], ['Планка', 'Пресс'], ['Подъём ног в висе', 'Пресс'],
  ['Беговая дорожка', 'Кардио'], ['Велотренажёр', 'Кардио'],
];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function defaultState() {
  return {
    exercises: DEFAULT_EXERCISES.map(([name, group]) => ({ id: uid(), name, group })),
    workouts: [],   // завершённые тренировки
    templates: [],  // { id, name, exIds: [] }
    active: null,   // текущая тренировка
    settings: { rest: 90 },
  };
}

// Упражнения «на время» (кардио, планка): без веса и повторов
const defaultKind = (name, group) => (group === 'Кардио' || name === 'Планка' ? 'time' : 'weight');

function migrate(st) {
  st = Object.assign(defaultState(), st);
  st.exercises.forEach(e => { if (!e.kind) e.kind = defaultKind(e.name, e.group); });
  return st;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { console.error(e); }
  return null;
}

let state = load() || migrate({});
let idbSaveTimer = null;

// Основная копия — localStorage, запасная — IndexedDB (если одно хранилище потеряется, восстановимся из другого)
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.error(e); alert('Не удалось сохранить данные: ' + e.message); }
  clearTimeout(idbSaveTimer);
  idbSaveTimer = setTimeout(() => idb('kv', 'readwrite', st => st.put(JSON.stringify(state), 'state')).catch(() => {}), 300);
}

// Если localStorage пуст, а в IndexedDB есть данные — восстанавливаем
async function restoreFromBackupStore() {
  if (localStorage.getItem(STORAGE_KEY)) return false;
  try {
    const raw = await idb('kv', 'readonly', st => st.get('state'));
    if (!raw) return false;
    state = migrate(JSON.parse(raw));
    localStorage.setItem(STORAGE_KEY, raw);
    return true;
  } catch { return false; }
}

// Просим браузер не удалять данные при нехватке места
async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const exById = id => state.exercises.find(e => e.id === id);
const exName = id => (exById(id) || { name: 'Удалённое упражнение' }).name;
const isTime = id => exById(id)?.kind === 'time';

/* ================== Фото тренажёров (IndexedDB) ================== */

const photoUrls = new Map(); // exId -> objectURL для показа

function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('gym-photos', 3);
    open.onupgradeneeded = () => {
      for (const name of ['photos', 'kv', 'videos']) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function photoEntries() {
  const [keys, vals] = await Promise.all([idb('photos', 'readonly', s => s.getAllKeys()), idb('photos', 'readonly', s => s.getAll())]);
  return keys.map((k, i) => [k, vals[i]]);
}

const blobToDataUrl = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
const toBlob = async v => (typeof v === 'string' ? (await fetch(v)).blob() : v);

async function setPhotoUrl(exId, value) {
  if (photoUrls.has(exId)) URL.revokeObjectURL(photoUrls.get(exId));
  photoUrls.delete(exId);
  if (value) photoUrls.set(exId, URL.createObjectURL(await toBlob(value)));
}

// Фото храним строкой (dataURL): Safari на iPhone иногда теряет Blob-объекты в IndexedDB
async function savePhoto(exId, blob) {
  const value = blob ? await blobToDataUrl(blob) : null;
  await idb('photos', 'readwrite', s => (value ? s.put(value, exId) : s.delete(exId)));
  // проверяем, что действительно записалось
  if (value && !(await idb('photos', 'readonly', s => s.get(exId)))) throw new Error('фото не записалось');
  await setPhotoUrl(exId, value);
}

async function savePhotoSafe(exId, blob) {
  try { await savePhoto(exId, blob); return true; }
  catch (e) { alert('Не удалось сохранить фото: ' + (e.message || e)); return false; }
}

async function loadPhotos() {
  try { for (const [k, v] of await photoEntries()) await setPhotoUrl(k, v); }
  catch (e) { console.error('Фото недоступны', e); }
}

// Уменьшаем фото с камеры (несколько МБ) до ~100 КБ
function shrinkImage(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.75);
    };
    img.onerror = () => reject(new Error('Не удалось открыть изображение'));
    img.src = URL.createObjectURL(file);
  });
}

// Поле выбора файла должно быть в документе: на iPhone «оторванное» поле иногда не сообщает о выбранном файле
function filePicker(accept) {
  document.querySelectorAll('input.file-picker').forEach(el => el.remove());
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.className = 'file-picker';
  input.style.cssText = 'position:fixed;left:-1000px;opacity:0';
  document.body.appendChild(input);
  return input;
}

// Открывает выбор: камера или галерея (телефон сам предложит варианты)
function pickImage() {
  return new Promise(resolve => {
    const input = filePicker('image/*');
    input.onchange = async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return resolve(null);
      try { resolve(await shrinkImage(file)); }
      catch { alert('Не удалось обработать фото.'); resolve(null); }
    };
    input.click();
  });
}

const techBtn = exId => `<button class="tech-btn ${hasTechnique(exId) ? 'has' : ''}" data-action="technique" data-id="${exId}" aria-label="Видео техники">▶</button>`;

const thumb = (exId, cls = 'thumb') => photoUrls.has(exId)
  ? `<img class="${cls}" src="${photoUrls.get(exId)}" alt="">`
  : `<span class="${cls} no-photo">📷</span>`;

function showPhoto(exId) {
  openModal(`
    <h2>${esc(exName(exId))}</h2>
    <img class="photo-full" src="${photoUrls.get(exId)}" alt="Фото тренажёра">
    <div class="row" style="margin-top:12px">
      <button class="btn grow" data-action="replace-photo" data-id="${exId}">📷 Заменить</button>
      <button class="btn danger" data-action="remove-photo" data-id="${exId}">Удалить</button>
    </div>
    <button class="btn block" style="margin-top:8px" data-action="close-modal">Закрыть</button>`);
}

/* ================== Видео техники ================== */

const videoIds = new Set(); // упражнения, у которых есть своё видео (сами файлы читаем по требованию)
let openVideoUrl = null;

async function loadVideoIds() {
  try { (await idb('videos', 'readonly', s => s.getAllKeys())).forEach(k => videoIds.add(k)); }
  catch (e) { console.error('Видео недоступны', e); }
}

const hasTechnique = exId => videoIds.has(exId) || !!exById(exId)?.video;

function youtubeInfo(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? { id: m[1], vertical: /\/shorts\//.test(url) } : null;
}

const MAX_VIDEO_MB = 150;

function pickVideo() {
  return new Promise(resolve => {
    const input = filePicker('video/*');
    input.onchange = () => {
      const file = input.files[0];
      input.remove();
      if (!file) return resolve(null);
      if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
        alert(`Видео слишком большое (${Math.round(file.size / 1048576)} МБ). Обрежьте его до короткого фрагмента — до ${MAX_VIDEO_MB} МБ.`);
        return resolve(null);
      }
      resolve(file);
    };
    input.click();
  });
}

async function saveVideo(exId, file) {
  try {
    if (file) {
      await idb('videos', 'readwrite', s => s.put(new Blob([file], { type: file.type || 'video/mp4' }), exId));
      if (!(await idb('videos', 'readonly', s => s.getKey(exId)))) throw new Error('видео не записалось');
      videoIds.add(exId);
      requestPersist();
    } else {
      await idb('videos', 'readwrite', s => s.delete(exId));
      videoIds.delete(exId);
    }
    return true;
  } catch (e) {
    alert('Не удалось сохранить видео: ' + (e.message || e) + '\nВозможно, на телефоне мало места.');
    return false;
  }
}

async function showTechnique(exId) {
  const ex = exById(exId);
  if (!ex) return;
  let ownSrc = null;
  if (openVideoUrl) { URL.revokeObjectURL(openVideoUrl); openVideoUrl = null; }
  if (videoIds.has(exId)) {
    try {
      const blob = await idb('videos', 'readonly', s => s.get(exId));
      if (blob) ownSrc = openVideoUrl = URL.createObjectURL(blob);
    } catch { /* не прочиталось */ }
  }
  const yt = youtubeInfo(ex.video);
  const linkHtml = !ex.video ? '' : yt
    ? `<div class="video-box ${yt.vertical ? 'vertical' : ''}"><iframe src="https://www.youtube-nocookie.com/embed/${yt.id}?playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Видео техники"></iframe></div>
       <a class="btn small ghost" href="${esc(ex.video)}" target="_blank" rel="noopener">Открыть в YouTube ↗</a>`
    : `<a class="btn block" href="${esc(ex.video)}" target="_blank" rel="noopener">▶ Открыть видео ↗</a>`;
  const query = encodeURIComponent(`${ex.name} техника выполнения`);

  openModal(`
    <h2>${esc(ex.name)} — техника</h2>
    ${ownSrc ? `<video class="own-video" src="${ownSrc}" controls playsinline preload="metadata"></video>
      <div class="row" style="margin:6px 0 12px"><button class="btn small grow" data-action="video-own" data-id="${exId}">🎥 Заменить своё видео</button>
      <button class="btn small danger" data-action="video-own-remove" data-id="${exId}">Удалить</button></div>` : ''}
    ${linkHtml}
    ${!ownSrc && !ex.video ? '<p class="muted">Видео пока нет. Найдите ролик на YouTube и вставьте ссылку или прикрепите своё видео (например, снятое тренером).</p>' : ''}

    <div class="section-title">Ссылка на видео</div>
    <div class="row">
      <input id="video-url" inputmode="url" placeholder="https://youtu.be/…" value="${esc(ex.video || '')}">
      <button class="btn" data-action="video-paste" aria-label="Вставить из буфера">📋</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn primary grow" data-action="video-link-save" data-id="${exId}">Сохранить ссылку</button>
      ${ex.video ? `<button class="btn danger" data-action="video-link-remove" data-id="${exId}">Убрать</button>` : ''}
    </div>
    <a class="btn block" style="margin-top:8px" href="https://www.youtube.com/results?search_query=${query}" target="_blank" rel="noopener">🔍 Найти на YouTube</a>
    <p class="muted" style="font-size:13px">В YouTube нажмите «Поделиться» → «Копировать ссылку», вернитесь сюда и нажмите 📋.</p>
    ${ownSrc ? '' : `<button class="btn block" data-action="video-own" data-id="${exId}">🎥 Своё видео — снять или выбрать</button>`}
    <button class="btn block" style="margin-top:8px" data-action="close-modal">Закрыть</button>`);
}

/* ================== Утилиты ================== */

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
const fmtNum = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU');

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const fmtMinutes = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`; };
const fmtDate = iso => new Date(iso).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
const fmtDateShort = iso => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

// Оценка одноповторного максимума (формула Эпли)
const e1rm = (w, r) => (r <= 0 || w <= 0) ? 0 : (r === 1 ? w : w * (1 + r / 30));

const setSeconds = s => Math.round(num(s.m) * 60 + num(s.s));
function fmtTime(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return m ? `${h} ч ${m} мин` : `${h} ч`;
  if (!s) return `${m} мин`;
  return m ? `${m} мин ${s} с` : `${s} с`;
}
const fmtSet = (exId, s) => (isTime(exId) ? fmtTime(setSeconds(s)) : `${fmtNum(num(s.w))} кг × ${num(s.r)}`);
const fmtSetShort = (exId, s) => (isTime(exId) ? fmtTime(setSeconds(s)) : `${fmtNum(num(s.w))}×${num(s.r)}`);
// Подход заполнен — значит выполнен, даже если не нажали ✓
// Подход «тронут», если в нём введено хоть одно число (подсказки серым не считаются)
const isFilled = (exId, s) => (isTime(exId) ? `${s.m ?? ''}${s.s ?? ''}` : `${s.w ?? ''}${s.r ?? ''}`).trim() !== '';
const itemSeconds = it => doneSets(it).reduce((a, s) => a + setSeconds(s), 0);

const doneSets = item => item.sets.filter(s => s.done);
const workoutVolume = w => w.items.reduce((sum, it) => sum + doneSets(it).reduce((a, s) => a + num(s.w) * num(s.r), 0), 0);

// Подходы из последней завершённой тренировки с этим упражнением
function lastSetsFor(exId) {
  for (let i = state.workouts.length - 1; i >= 0; i--) {
    const it = state.workouts[i].items.find(x => x.exId === exId);
    if (it && doneSets(it).length) return doneSets(it);
  }
  return null;
}

// Лучший результат (по e1RM) за всю историю
function bestFor(exId, workouts = state.workouts) {
  let best = 0;
  for (const w of workouts) for (const it of w.items) if (it.exId === exId)
    for (const s of doneSets(it)) best = Math.max(best, e1rm(num(s.w), num(s.r)));
  return best;
}

/* ================== Навигация ================== */

let tab = 'workout';
const TITLES = { workout: 'Тренировка', history: 'История', progress: 'Прогресс', exercises: 'Упражнения' };
const VIEWS = { workout: () => viewWorkout(), history: () => viewHistory(), progress: () => viewProgress(), exercises: () => viewExercises() };

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  render();
  window.scrollTo(0, 0);
}

function render() {
  $('#title').textContent = TITLES[tab];
  $('#view').innerHTML = VIEWS[tab]();
}

/* ================== Вкладка «Тренировка» ================== */

function viewWorkout() {
  const a = state.active;
  if (!a) {
    const tpl = state.templates.map(t => `
      <div class="list-item">
        <button class="grow" style="background:none;border:0;text-align:left;padding:0" data-action="start-template" data-id="${t.id}">
          <div>${t.planId ? '<span class="badge plan">План</span> ' : ''}${esc(t.name)}</div>
          <div class="muted">${t.exIds.map(exName).map(esc).join(', ')}</div>
        </button>
        <button class="btn small danger" data-action="delete-template" data-id="${t.id}">✕</button>
      </div>`).join('');
    const last = state.workouts[state.workouts.length - 1];
    const warn = isIOS() && !isStandalone() ? `
      <div class="card warn">⚠️ Приложение открыто во вкладке Safari. На iPhone у вкладки и у иконки на экране «Домой» <b>разные хранилища</b>,
      а данные вкладки Safari может стереть через 7 дней без посещений. Установите приложение (Поделиться → «На экран „Домой“»)
      и записывайте тренировки только через иконку.</div>` : '';
    const lastBackup = state.settings.lastBackup;
    const backupWarn = state.workouts.length && (!lastBackup || Date.now() - new Date(lastBackup) > 7 * 864e5) ? `
      <div class="card warn row"><div class="grow">💾 ${lastBackup ? `Резервная копия не делалась с ${fmtDateShort(lastBackup)}` : 'Вы ещё ни разу не сохраняли резервную копию'}.</div>
      <button class="btn small" data-action="export">Сохранить</button></div>` : '';
    return `${warn}${backupWarn}
      <button class="btn primary block" data-action="start-empty">＋ Начать тренировку</button>
      ${last ? `<p class="muted" style="text-align:center">Последняя: ${fmtDate(last.start)} · ${esc(last.name)}</p>` : ''}
      <div class="section-title">${state.plan ? 'План и шаблоны' : 'Шаблоны'}</div>
      ${tpl || '<div class="muted card">Шаблонов пока нет. Завершив тренировку, можно сохранить её как шаблон, чтобы в следующий раз начать в одно касание.</div>'}`;
  }

  const items = a.items.map((it, i) => {
    const prev = lastSetsFor(it.exId);
    const timed = isTime(it.exId);
    const rows = it.sets.map((s, j) => {
      const p = prev && prev[j];
      const prevTxt = p ? fmtSetShort(it.exId, p) : '—';
      const fields = timed ? `
          <td><input inputmode="numeric" placeholder="${esc(s.pm || 'мин')}" value="${esc(s.m ?? '')}" data-field="m" data-i="${i}" data-j="${j}"></td>
          <td><input inputmode="numeric" placeholder="${esc(s.ps || 'сек')}" value="${esc(s.s ?? '')}" data-field="s" data-i="${i}" data-j="${j}"></td>` : `
          <td><input inputmode="decimal" placeholder="${esc(s.pw || 'кг')}" value="${esc(s.w ?? '')}" data-field="w" data-i="${i}" data-j="${j}"></td>
          <td><input inputmode="numeric" placeholder="${esc(s.pr || 'раз')}" value="${esc(s.r ?? '')}" data-field="r" data-i="${i}" data-j="${j}"></td>`;
      return `
        <tr class="${s.done ? 'done' : ''}">
          <td>${j + 1}</td>
          <td class="prev">${prevTxt}</td>${fields}
          <td><button class="check" data-action="toggle-set" data-i="${i}" data-j="${j}" aria-label="Выполнено">✓</button></td>
          <td><button class="del-set" data-action="del-set" data-i="${i}" data-j="${j}" aria-label="Удалить подход">×</button></td>
        </tr>`;
    }).join('');
    return `
      <div class="card">
        <div class="ex-head">
          <button class="thumb-btn" data-action="photo" data-id="${it.exId}" aria-label="Фото тренажёра">${thumb(it.exId)}</button>
          <div class="grow"><h3>${esc(exName(it.exId))}</h3>${it.target ? `<div class="target">🎯 ${esc(targetText(it.exId, it.target))}</div>` : ''}</div>
          ${techBtn(it.exId)}
          <button class="icon-btn" data-action="remove-ex" data-i="${i}" aria-label="Убрать упражнение">✕</button>
        </div>
        ${it.target?.note ? `<div class="muted target-note">${esc(it.target.note)}</div>` : ''}
        <table class="sets">
          <thead><tr><th>#</th><th>Прошлый</th>${timed ? '<th>Мин</th><th>Сек</th>' : '<th>Вес</th><th>Повт.</th>'}<th></th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <button class="btn ghost small" data-action="add-set" data-i="${i}">＋ ${timed ? 'Ещё отрезок' : 'Подход'}</button>
      </div>`;
  }).join('');

  return `
    <div class="timer-bar">
      <div><div class="muted">${esc(a.name)}</div><strong id="elapsed">${fmtDuration(Date.now() - new Date(a.start))}</strong></div>
      <button class="btn primary" data-action="finish">Завершить</button>
    </div>
    ${items || '<div class="empty">Добавьте первое упражнение 👇</div>'}
    <button class="btn block" data-action="pick-exercise">＋ Добавить упражнение</button>
    <div style="margin-top:12px"><textarea rows="2" placeholder="Заметка к тренировке (самочувствие, сон…)" data-field="note">${esc(a.note || '')}</textarea></div>
    <button class="btn danger block" style="margin-top:12px" data-action="cancel-workout">Отменить тренировку</button>`;
}

function startWorkout(name, exIds = [], targets = null) {
  state.active = {
    id: uid(),
    name,
    start: new Date().toISOString(),
    note: '',
    items: exIds.filter(exById).map(id => newItem(id, targets?.[id])),
  };
  save();
  render();
}

// Новое упражнение в тренировке: столько же подходов, сколько было в прошлый раз, с теми же весами
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

// Подсказки (серым) берём из плана, иначе из прошлой тренировки. Значения не подставляем:
// подход считается сделанным, только когда вы нажали ✓ или ввели числа сами.
function newItem(exId, target = null) {
  const prev = lastSetsFor(exId) || [];
  const timed = isTime(exId);
  const n = Math.max(1, Math.min(20, Math.round(num(target?.sets)) || prev.length || 1));
  const sets = Array.from({ length: n }, (_, j) => {
    const p = prev[j] || prev[prev.length - 1] || {};
    if (timed) {
      const pm = target?.minutes != null && num(target.minutes) ? String(target.minutes) : (p.m ?? '');
      return { m: '', s: '', pm, ps: target?.minutes != null ? '' : (p.s ?? ''), done: false };
    }
    const pw = target?.weight != null && target.weight !== '' ? String(target.weight) : (p.w ?? '');
    const pr = target?.reps != null && target.reps !== '' ? String(target.reps) : (p.r ?? '');
    return { w: '', r: '', pw, pr, done: false };
  });
  return target ? { exId, sets, target } : { exId, sets };
}

const firstNum = v => (String(v ?? '').match(/\d+(?:[.,]\d+)?/) || [''])[0].replace(',', '.');

// ✓ без введённых чисел — принимаем подсказку
function acceptPlaceholders(s, timed) {
  if (timed) {
    if (s.m === '' && s.s === '') { s.m = firstNum(s.pm); s.s = firstNum(s.ps); }
  } else {
    if (s.w === '' || s.w == null) s.w = firstNum(s.pw);
    if (s.r === '' || s.r == null) s.r = firstNum(s.pr);
  }
}

function targetText(exId, t) {
  if (isTime(exId)) return [t.sets > 1 ? `${t.sets} отрезка` : '', t.minutes ? `${t.minutes} мин` : ''].filter(Boolean).join(' × ') || 'по плану';
  const parts = [`${t.sets || '?'}×${t.reps || '?'}`];
  if (t.weight != null && t.weight !== '') parts.push(`${t.weight} кг`);
  if (t.rest) parts.push(`отдых ${t.rest >= 60 ? fmtDuration(t.rest * 1000) : t.rest + ' с'}`);
  return parts.join(' · ');
}

function finishWorkout() {
  const a = state.active;
  const items = a.items
    .map(it => ({ ...it, sets: it.sets.filter(s => s.done || isFilled(it.exId, s)).map(s => {
      const out = { ...s, done: true };
      acceptPlaceholders(out, isTime(it.exId));
      return out;
    }) }))
    .filter(it => it.sets.length);
  if (!items.length) {
    alert('Пока нечего сохранять: заполните хотя бы один подход (повторы или время).\n\nЕсли тренировка не нужна — нажмите «Отменить тренировку» внизу.');
    return;
  }
  a.items = items;
  // Отмечаем рекорды
  const prs = [];
  for (const it of a.items) {
    const before = bestFor(it.exId);
    const now = Math.max(...it.sets.map(s => e1rm(num(s.w), num(s.r))));
    if (now > before && before > 0) prs.push(exName(it.exId));
  }
  a.end = new Date().toISOString();
  state.workouts.push(a);
  state.active = null;
  stopRest();
  save();

  const isTemplate = state.templates.some(t => t.exIds.join() === a.items.map(i => i.exId).join());
  openModal(`
    <h2>Тренировка завершена 💪</h2>
    <div class="stats">
      <div class="stat"><strong>${fmtMinutes(new Date(a.end) - new Date(a.start))}</strong><span>время</span></div>
      <div class="stat"><strong>${a.items.reduce((n, i) => n + (isTime(i.exId) ? 0 : i.sets.length), 0)}</strong><span>подходов</span></div>
      <div class="stat"><strong>${fmtNum(workoutVolume(a))}</strong><span>кг объём</span></div>
    </div>
    ${prs.length ? `<div class="card"><span class="badge pr">🏆 Новый рекорд</span><div style="margin-top:6px">${prs.map(esc).join(', ')}</div></div>` : ''}
    ${isTemplate ? '' : `
      <label>Сохранить как шаблон</label>
      <div class="row"><input id="tpl-name" value="${esc(a.name)}"><button class="btn primary" data-action="save-template" data-id="${a.id}">Сохранить</button></div>`}
    <button class="btn block" style="margin-top:12px" data-action="close-modal">Готово</button>`);
  setTab('history');
  requestPersist();
}

/* ================== Выбор упражнения ================== */

let pickerGroup = 'Все';

function openPicker() {
  openModal(`
    <h2>Добавить упражнение</h2>
    <input id="picker-search" placeholder="Поиск…" autocomplete="off">
    <div class="chips" style="margin-top:10px" id="picker-chips"></div>
    <div id="picker-list"></div>
    <button class="btn block" data-action="new-exercise" data-then="add">＋ Создать новое упражнение</button>`);
  renderPicker();
  $('#picker-search').addEventListener('input', renderPicker);
}

function renderPicker() {
  const q = ($('#picker-search')?.value || '').toLowerCase().trim();
  $('#picker-chips').innerHTML = ['Все', ...GROUPS].map(g =>
    `<button class="chip ${g === pickerGroup ? 'active' : ''}" data-action="picker-group" data-g="${g}">${g}</button>`).join('');
  const inWorkout = new Set((state.active?.items || []).map(i => i.exId));
  const list = state.exercises
    .filter(e => (pickerGroup === 'Все' || e.group === pickerGroup) && e.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  $('#picker-list').innerHTML = list.map(e => `
    <button class="list-item" data-action="add-ex" data-id="${e.id}" ${inWorkout.has(e.id) ? 'style="opacity:.5"' : ''}>
      ${photoUrls.has(e.id) ? thumb(e.id, 'thumb small') : ''}
      <div class="grow"><div>${esc(e.name)}</div><div class="muted">${esc(e.group)}</div></div>
      <span>${inWorkout.has(e.id) ? '✓' : '＋'}</span>
    </button>`).join('') || '<div class="empty">Ничего не найдено</div>';
}

/* ================== Таймер отдыха ================== */

let restEnd = 0, restTimer = null;

function startRest(sec = state.settings.rest) {
  if (!sec) return;
  restEnd = Date.now() + sec * 1000;
  $('#rest').classList.remove('hidden');
  clearInterval(restTimer);
  restTimer = setInterval(tickRest, 250);
  tickRest();
}
function tickRest() {
  const left = restEnd - Date.now();
  const el = $('#rest');
  el.classList.toggle('over', left < 0);
  $('#rest-time').textContent = (left < 0 ? '+' : '') + fmtDuration(Math.abs(left));
  if (left < 0 && !el.dataset.buzzed) {
    el.dataset.buzzed = '1';
    navigator.vibrate?.([200, 100, 200]);
    beep();
  }
}
function stopRest() {
  clearInterval(restTimer);
  $('#rest').classList.add('hidden');
  delete $('#rest').dataset.buzzed;
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.start(); o.stop(ctx.currentTime + 0.6);
  } catch { /* звук недоступен */ }
}

/* ================== Вкладка «История» ================== */

function viewHistory() {
  if (!state.workouts.length) return '<div class="empty">Здесь появятся завершённые тренировки</div>';
  let lastMonth = '';
  return state.workouts.slice().reverse().map(w => {
    const month = new Date(w.start).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    const header = month !== lastMonth ? `<div class="section-title">${month}</div>` : '';
    lastMonth = month;
    return `${header}
      <button class="list-item" data-action="show-workout" data-id="${w.id}">
        <div class="grow">
          <div>${esc(w.name)}</div>
          <div class="muted">${fmtDate(w.start)} · ${fmtMinutes(new Date(w.end) - new Date(w.start))} · ${fmtNum(workoutVolume(w))} кг</div>
          <div class="muted">${w.items.map(i => esc(exName(i.exId))).join(', ')}</div>
        </div>
        <span class="muted">›</span>
      </button>`;
  }).join('');
}

function showWorkout(id) {
  const w = state.workouts.find(x => x.id === id);
  if (!w) return;
  openModal(`
    <h2>${esc(w.name)}</h2>
    <p class="muted">${fmtDate(w.start)}, ${new Date(w.start).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${fmtMinutes(new Date(w.end) - new Date(w.start))} · ${fmtNum(workoutVolume(w))} кг</p>
    ${w.items.map(it => `
      <div class="card">
        <div class="row">${photoUrls.has(it.exId) ? thumb(it.exId, 'thumb small') : ''}<h3 class="grow" style="margin:0">${esc(exName(it.exId))}</h3></div>
        ${it.sets.map((s, j) => `<div class="row between"><span class="muted">${isTime(it.exId) ? (it.sets.length > 1 ? `Отрезок ${j + 1}` : 'Время') : `Подход ${j + 1}`}</span><span>${fmtSet(it.exId, s)}</span></div>`).join('')}
      </div>`).join('')}
    ${w.note ? `<div class="card"><div class="muted">Заметка</div>${esc(w.note)}</div>` : ''}
    <div class="row">
      <button class="btn grow" data-action="repeat-workout" data-id="${w.id}">↻ Повторить</button>
      <button class="btn danger" data-action="delete-workout" data-id="${w.id}">Удалить</button>
    </div>
    <button class="btn block" style="margin-top:8px" data-action="close-modal">Закрыть</button>`);
}

/* ================== Вкладка «Прогресс» ================== */

let progressEx = null;

function viewProgress() {
  const ws = state.workouts;
  const now = new Date();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisWeek = ws.filter(w => new Date(w.start) >= weekStart).length;
  const thisMonth = ws.filter(w => new Date(w.start) >= monthStart).length;

  const used = [...new Set(ws.flatMap(w => w.items.map(i => i.exId)))].filter(exById)
    .sort((a, b) => exName(a).localeCompare(exName(b), 'ru'));
  if (!used.includes(progressEx)) progressEx = used[0] || null;

  let chartHtml = '<div class="empty">Проведите первую тренировку, чтобы увидеть прогресс</div>';
  if (progressEx && isTime(progressEx)) {
    const points = ws.map(w => {
      const it = w.items.find(i => i.exId === progressEx);
      return it && itemSeconds(it) ? { date: w.start, sec: itemSeconds(it) } : null;
    }).filter(Boolean);
    const best = points.reduce((b, p) => (p.sec > b.sec ? p : b), points[0] || { sec: 0 });
    chartHtml = `
      <div class="card">
        ${progressSelect(used)}
        ${points.length ? `
        <div class="muted" style="margin:10px 0 4px">Время за тренировку, мин</div>
        ${chartSvg(points.map(p => ({ x: p.date, y: p.sec / 60 })))}
        <div class="row between" style="margin-top:8px"><span class="muted">Дольше всего</span>
          <span><span class="badge pr">🏆</span> ${fmtTime(best.sec)} · ${fmtDateShort(best.date)}</span></div>
        <div class="row between"><span class="muted">Всего</span><span>${fmtTime(points.reduce((a, p) => a + p.sec, 0))}</span></div>
        <div class="row between"><span class="muted">Тренировок с упражнением</span><span>${points.length}</span></div>`
        : '<div class="empty">Нет записей со временем</div>'}
      </div>
      <div class="section-title">Последние результаты</div>
      ${points.slice(-6).reverse().map(p => `
        <div class="list-item"><div class="grow"><div>${fmtDate(p.date)}</div></div><span>${fmtTime(p.sec)}</span></div>`).join('')}`;
  } else if (progressEx) {
    const points = ws.map(w => {
      const it = w.items.find(i => i.exId === progressEx);
      if (!it) return null;
      const sets = doneSets(it).filter(s => num(s.r) > 0);
      if (!sets.length) return null;
      return {
        date: w.start,
        e1rm: Math.max(...sets.map(s => e1rm(num(s.w), num(s.r)))),
        maxW: Math.max(...sets.map(s => num(s.w))),
        vol: sets.reduce((a, s) => a + num(s.w) * num(s.r), 0),
        best: sets.reduce((b, s) => (e1rm(num(s.w), num(s.r)) > e1rm(num(b.w), num(b.r)) ? s : b), sets[0]),
      };
    }).filter(Boolean);
    const best = points.reduce((b, p) => (p.e1rm > b.e1rm ? p : b), points[0] || {});
    chartHtml = `
      <div class="card">
        ${progressSelect(used)}
        ${points.length ? `
        <div class="muted" style="margin:10px 0 4px">Расчётный максимум на 1 повтор, кг</div>
        ${chartSvg(points.map(p => ({ x: p.date, y: p.e1rm })))}
        <div class="row between" style="margin-top:8px">
          <span class="muted">Рекорд</span>
          <span><span class="badge pr">🏆</span> ${fmtNum(num(best.best.w))} кг × ${num(best.best.r)} · ${fmtDateShort(best.date)}</span>
        </div>
        <div class="row between"><span class="muted">Макс. вес</span><span>${fmtNum(Math.max(...points.map(p => p.maxW)))} кг</span></div>
        <div class="row between"><span class="muted">Тренировок с упражнением</span><span>${points.length}</span></div>`
        : '<div class="empty">Нет записей с повторами</div>'}
      </div>
      <div class="section-title">Последние результаты</div>
      ${points.slice(-6).reverse().map(p => `
        <div class="list-item"><div class="grow"><div>${fmtDate(p.date)}</div><div class="muted">объём ${fmtNum(p.vol)} кг</div></div>
        <span>${fmtNum(num(p.best.w))} × ${num(p.best.r)}</span></div>`).join('')}`;
  }

  return `
    <div class="stats">
      <div class="stat"><strong>${thisWeek}</strong><span>на этой неделе</span></div>
      <div class="stat"><strong>${thisMonth}</strong><span>в этом месяце</span></div>
      <div class="stat"><strong>${ws.length}</strong><span>всего</span></div>
    </div>
    ${chartHtml}`;
}

const progressSelect = used => `<select data-action="progress-select">${used.map(id => `<option value="${id}" ${id === progressEx ? 'selected' : ''}>${esc(exName(id))}</option>`).join('')}</select>`;

function chartSvg(pts) {
  const W = 320, H = 200, pl = 34, pr = 10, pt = 10, pb = 24;
  if (pts.length === 1) pts = [pts[0], pts[0]];
  const ys = pts.map(p => p.y);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (max === min) { min -= 5; max += 5; }
  const pad = (max - min) * 0.1; min = Math.max(0, min - pad); max += pad;
  const x = i => pl + (i / (pts.length - 1)) * (W - pl - pr);
  const y = v => pt + (1 - (v - min) / (max - min)) * (H - pt - pb);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - pb} L${x(0).toFixed(1)},${H - pb} Z`;
  const grid = [0, 0.5, 1].map(f => {
    const v = min + (max - min) * f;
    return `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 4}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}
    <path d="${area}" fill="var(--accent)" opacity=".12"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="3" fill="var(--accent)"/>`).join('')}
    <text x="${pl}" y="${H - 6}">${fmtDateShort(pts[0].x)}</text>
    <text x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtDateShort(pts[pts.length - 1].x)}</text>
  </svg>`;
}

/* ================== Вкладка «Упражнения» ================== */

function viewExercises() {
  return `
    <button class="btn primary block" data-action="new-exercise">＋ Новое упражнение</button>
    ${GROUPS.map(g => {
      const list = state.exercises.filter(e => e.group === g).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      if (!list.length) return '';
      return `<div class="section-title">${g}</div>` + list.map(e => {
        const best = bestFor(e.id);
        return `
          <div class="list-item">
            <button class="thumb-btn" data-action="photo" data-id="${e.id}" aria-label="Фото тренажёра">${thumb(e.id, 'thumb small')}</button>
            <div class="grow"><div>${esc(e.name)}</div>${e.kind === 'time' ? '<div class="muted">на время</div>' : best ? `<div class="muted">лучший 1ПМ ≈ ${fmtNum(best)} кг</div>` : ''}</div>
            ${techBtn(e.id)}
            <button class="btn small" data-action="edit-exercise" data-id="${e.id}">✎</button>
          </div>`;
      }).join('');
    }).join('')}`;
}

let pendingPhoto; // undefined — без изменений, Blob — новое фото, null — удалить

function exerciseForm(ex, then = '') {
  pendingPhoto = undefined;
  openModal(`
    <h2>${ex ? 'Изменить упражнение' : 'Новое упражнение'}</h2>
    <div class="stack">
      <div><label>Название</label><input id="ex-name" value="${esc(ex?.name || '')}" placeholder="Например, Жим Арнольда"></div>
      <div><label>Группа мышц</label><select id="ex-group">${GROUPS.map(g => `<option ${g === (ex?.group || pickerGroup) ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
      <div><label>Что записываем</label><select id="ex-kind">
        <option value="weight" ${(ex?.kind || defaultKind('', ex?.group || pickerGroup)) === 'weight' ? 'selected' : ''}>Вес и повторы</option>
        <option value="time" ${(ex?.kind || defaultKind('', ex?.group || pickerGroup)) === 'time' ? 'selected' : ''}>Только время</option>
      </select></div>
      <div><label>Фото тренажёра</label><div id="form-photo"></div></div>
      ${ex ? `<button class="btn block" data-action="technique" data-id="${ex.id}">▶ Видео техники${hasTechnique(ex.id) ? ' ✓' : ''}</button>` : ''}
      <button class="btn primary block" data-action="save-exercise" data-id="${ex?.id || ''}" data-then="${then}">Сохранить</button>
      ${ex ? `<button class="btn danger block" data-action="delete-exercise" data-id="${ex.id}">Удалить упражнение</button>` : ''}
      <button class="btn block" data-action="close-modal">Отмена</button>
    </div>`);
  renderFormPhoto(ex?.id);
  if (!ex) setTimeout(() => $('#ex-name').focus(), 50);
}

function renderFormPhoto(exId) {
  const url = pendingPhoto ? URL.createObjectURL(pendingPhoto) : (pendingPhoto === null ? null : photoUrls.get(exId));
  $('#form-photo').innerHTML = url
    ? `<img class="photo-full" src="${url}" alt=""><div class="row" style="margin-top:6px">
         <button class="btn small grow" data-action="form-photo" data-id="${exId || ''}">📷 Заменить</button>
         <button class="btn small danger" data-action="form-photo-remove" data-id="${exId || ''}">Удалить фото</button></div>`
    : `<button class="btn block" data-action="form-photo" data-id="${exId || ''}">📷 Сфотографировать или выбрать</button>`;
}

/* ================== Настройки ================== */

function openSettings() {
  openModal(`
    <h2>Настройки</h2>
    <div class="stack">
      <div><label>Таймер отдыха после подхода, секунд (0 — выключен)</label>
        <input id="set-rest" inputmode="numeric" value="${state.settings.rest}"></div>
      <button class="btn primary block" data-action="save-settings">Сохранить</button>
    </div>
    <div class="section-title">Данные</div>
    <p class="muted">Все данные хранятся только на этом устройстве. Делайте резервную копию, чтобы не потерять историю или перенести её на другой телефон.</p>
    <div class="card" id="storage-info"><div class="muted">Проверяю хранилище…</div></div>
    <div class="stack">
      <button class="btn block" data-action="export">⬇ Скачать резервную копию</button>
      <button class="btn block" data-action="import">⬆ Восстановить из файла</button>
      <button class="btn danger block" data-action="reset">Удалить все данные</button>
      <button class="btn block" data-action="close-modal">Закрыть</button>
    </div>`);
  storageInfo().then(html => { const el = $('#storage-info'); if (el) el.innerHTML = html; });
}

async function storageInfo() {
  const persisted = await (navigator.storage?.persisted?.() ?? Promise.resolve(false)).catch(() => false);
  let photos = 0;
  try { photos = (await idb('photos', 'readonly', st => st.count())) || 0; } catch { /* нет доступа */ }
  const last = state.settings.lastBackup;
  const line = (k, v) => `<div class="row between"><span class="muted">${k}</span><span>${v}</span></div>`;
  return line('Тренировок', state.workouts.length) + line('Фото тренажёров', photos) + line('Своих видео', videoIds.size)
    + line('Запущено', isStandalone() ? 'как приложение ✓' : 'во вкладке браузера')
    + line('Защита от очистки', persisted ? 'включена ✓' : 'нет')
    + line('Резервная копия', last ? fmtDateShort(last) : 'ни разу');
}

async function exportData() {
  const photos = {};
  try { for (const [k, v] of await photoEntries()) photos[k] = typeof v === 'string' ? v : await blobToDataUrl(v); } catch { /* без фото */ }
  const name = `gym-backup-${new Date().toISOString().slice(0, 10)}.json`;
  backupFile = new File([JSON.stringify({ ...state, photos }, null, 2)], name, { type: 'application/json' });
  // На iPhone удобнее «Поделиться» → «Сохранить в Файлы» / отправить себе в мессенджер
  if (navigator.canShare?.({ files: [backupFile] })) {
    openModal(`
      <h2>Резервная копия готова</h2>
      <p class="muted">Нажмите «Сохранить» и выберите <b>«Сохранить в Файлы»</b> (iCloud Drive) — или отправьте файл себе в мессенджер / на почту.
      Размер: ${Math.max(1, Math.round(backupFile.size / 1024))} КБ.</p>
      <button class="btn primary block" data-action="share-backup">📤 Сохранить</button>
      <button class="btn block" style="margin-top:8px" data-action="download-backup">⬇ Скачать файлом</button>
      <button class="btn block" style="margin-top:8px" data-action="close-modal">Закрыть</button>`);
  } else {
    downloadBackup();
  }
}

let backupFile = null;

function markBackedUp() {
  state.settings.lastBackup = new Date().toISOString();
  save();
}

function downloadBackup() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(backupFile);
  a.download = backupFile.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  markBackedUp();
}

async function shareBackup() {
  try {
    await navigator.share({ files: [backupFile], title: 'Мой зал — резервная копия' });
    markBackedUp();
    closeModal();
    render();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Не получилось поделиться файлом. Попробуйте «Скачать файлом».');
  }
}

function importData() {
  const input = filePicker('application/json,.json');
  input.onchange = async () => {
    try {
      const data = JSON.parse(await input.files[0].text());
      if (!Array.isArray(data.exercises) || !Array.isArray(data.workouts)) throw new Error('bad format');
      if (!confirm(`Найдено тренировок: ${data.workouts.length}. Заменить текущие данные?`)) return;
      const { photos = {}, ...rest } = data;
      state = migrate(rest);
      save();
      await clearPhotos();
      for (const [k, url] of Object.entries(photos)) {
        await idb('photos', 'readwrite', st => st.put(url, k));
        await setPhotoUrl(k, url);
      }
      closeModal(); render();
    } catch { alert('Не удалось прочитать файл резервной копии.'); }
  };
  input.click();
}

async function clearPhotos() {
  await idb('photos', 'readwrite', st => st.clear()).catch(() => {});
  for (const k of [...photoUrls.keys()]) await setPhotoUrl(k, null);
}

/* ================== Модальное окно ================== */

function openModal(html) {
  if (openVideoUrl && !html.includes(openVideoUrl)) { URL.revokeObjectURL(openVideoUrl); openVideoUrl = null; }
  $('#sheet').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#sheet').innerHTML = '';
  if (openVideoUrl) { URL.revokeObjectURL(openVideoUrl); openVideoUrl = null; }
}

/* ================== Обработчики ================== */

const actions = {
  'start-empty': () => startWorkout(`Тренировка ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`),
  'start-template': d => { const t = state.templates.find(x => x.id === d.id); if (t) startWorkout(t.name, t.exIds, t.targets); },
  'delete-template': d => { if (confirm('Удалить шаблон?')) { state.templates = state.templates.filter(t => t.id !== d.id); save(); render(); } },
  'pick-exercise': openPicker,
  'picker-group': d => { pickerGroup = d.g; renderPicker(); },
  'add-ex': d => {
    if (!state.active.items.some(i => i.exId === d.id)) state.active.items.push(newItem(d.id));
    save(); closeModal(); render();
  },
  'add-set': d => {
    const it = state.active.items[d.i], sets = it.sets, last = sets[sets.length - 1] || {};
    sets.push(isTime(it.exId)
      ? { m: '', s: '', pm: last.m || last.pm || '', ps: last.s || last.ps || '', done: false }
      : { w: '', r: '', pw: last.w || last.pw || '', pr: last.r || last.pr || '', done: false });
    save(); render();
  },
  'del-set': d => { state.active.items[d.i].sets.splice(d.j, 1); save(); render(); },
  'toggle-set': d => {
    const it = state.active.items[d.i], s = it.sets[d.j], timed = isTime(it.exId);
    s.done = !s.done;
    if (s.done) acceptPlaceholders(s, timed);
    save(); render();
    if (s.done && !timed) startRest(num(it.target?.rest) || state.settings.rest);
  },
  'remove-ex': d => { if (confirm('Убрать упражнение из тренировки?')) { state.active.items.splice(d.i, 1); save(); render(); } },
  'finish': finishWorkout,
  'cancel-workout': () => { if (confirm('Отменить тренировку? Введённые данные пропадут.')) { state.active = null; stopRest(); save(); render(); } },
  'save-template': d => {
    const w = state.workouts.find(x => x.id === d.id);
    state.templates.push({ id: uid(), name: $('#tpl-name').value.trim() || w.name, exIds: w.items.map(i => i.exId) });
    save(); closeModal(); render();
  },
  'rest-add': () => { restEnd += 30000; delete $('#rest').dataset.buzzed; tickRest(); },
  'rest-stop': stopRest,
  'show-workout': d => showWorkout(d.id),
  'repeat-workout': d => {
    if (state.active) return alert('Сначала завершите текущую тренировку.');
    const w = state.workouts.find(x => x.id === d.id);
    closeModal(); startWorkout(w.name, w.items.map(i => i.exId)); setTab('workout');
  },
  'delete-workout': d => {
    if (!confirm('Удалить эту тренировку из истории?')) return;
    state.workouts = state.workouts.filter(w => w.id !== d.id);
    save(); closeModal(); render();
  },
  'new-exercise': d => exerciseForm(null, d.then),
  'edit-exercise': d => exerciseForm(exById(d.id)),
  'save-exercise': async d => {
    const name = $('#ex-name').value.trim(), group = $('#ex-group').value, kind = $('#ex-kind').value;
    if (!name) return $('#ex-name').focus();
    let id = d.id;
    if (id) Object.assign(exById(id), { name, group, kind });
    else { id = uid(); state.exercises.push({ id, name, group, kind }); }
    if (d.then === 'add' && state.active) state.active.items.push(newItem(id));
    if (pendingPhoto !== undefined) await savePhotoSafe(id, pendingPhoto);
    save(); closeModal(); render();
  },
  'delete-exercise': d => {
    if (!confirm('Удалить упражнение? В истории оно останется как «Удалённое упражнение».')) return;
    state.exercises = state.exercises.filter(e => e.id !== d.id);
    state.templates.forEach(t => { t.exIds = t.exIds.filter(x => x !== d.id); });
    savePhoto(d.id, null).catch(() => {});
    if (videoIds.has(d.id)) saveVideo(d.id, null);
    save(); closeModal(); render();
  },
  'photo': async d => {
    if (photoUrls.has(d.id)) return showPhoto(d.id);
    const blob = await pickImage();
    if (blob && await savePhotoSafe(d.id, blob)) render();
  },
  'replace-photo': async d => {
    const blob = await pickImage();
    if (blob && await savePhotoSafe(d.id, blob)) { render(); showPhoto(d.id); }
  },
  'remove-photo': async d => {
    if (!confirm('Удалить фото?')) return;
    await savePhotoSafe(d.id, null); closeModal(); render();
  },
  'form-photo': async d => { const b = await pickImage(); if (b) { pendingPhoto = b; renderFormPhoto(d.id); } },
  'form-photo-remove': d => { pendingPhoto = null; renderFormPhoto(d.id); },
  'technique': d => showTechnique(d.id),
  'video-paste': async () => {
    try { $('#video-url').value = (await navigator.clipboard.readText()).trim(); }
    catch { alert('Не удалось прочитать буфер обмена. Вставьте ссылку в поле вручную (долгое нажатие → «Вставить»).'); }
  },
  'video-link-save': d => {
    const url = $('#video-url').value.trim();
    if (url && !/^https?:\/\//i.test(url)) return alert('Ссылка должна начинаться с https://');
    exById(d.id).video = url;
    save(); render(); showTechnique(d.id);
  },
  'video-link-remove': d => { delete exById(d.id).video; save(); render(); showTechnique(d.id); },
  'video-own': async d => {
    const file = await pickVideo();
    if (file && await saveVideo(d.id, file)) { render(); showTechnique(d.id); }
  },
  'video-own-remove': async d => {
    if (!confirm('Удалить своё видео?')) return;
    if (await saveVideo(d.id, null)) { render(); showTechnique(d.id); }
  },
  'open-settings': openSettings,
  'save-settings': () => { state.settings.rest = Math.max(0, Math.round(num($('#set-rest').value))); save(); closeModal(); },
  'export': exportData,
  'share-backup': shareBackup,
  'download-backup': downloadBackup,
  'import': importData,
  'reset': () => {
    if (!confirm('Точно удалить ВСЕ тренировки и упражнения?')) return;
    state = migrate({}); save(); stopRest(); closeModal();
    idb('videos', 'readwrite', st => st.clear()).catch(() => {});
    videoIds.clear();
    clearPhotos().finally(render);
  },
  'close-modal': closeModal,
};

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return setTab(tabBtn.dataset.tab);
  if (e.target.id === 'modal') return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const d = { ...el.dataset };
  if (d.i !== undefined) d.i = +d.i;
  if (d.j !== undefined) d.j = +d.j;
  actions[d.action]?.(d);
});

// Ввод веса/повторов и заметки — сохраняем без перерисовки, чтобы не терять фокус
document.addEventListener('input', e => {
  const f = e.target.dataset.field;
  if (!f || !state.active) return;
  if (f === 'note') state.active.note = e.target.value;
  else state.active.items[+e.target.dataset.i].sets[+e.target.dataset.j][f] = e.target.value;
  save();
});

document.addEventListener('change', e => {
  if (e.target.dataset.action === 'progress-select') { progressEx = e.target.value; render(); }
  if (e.target.id === 'ex-group' && $('#ex-kind')) $('#ex-kind').value = e.target.value === 'Кардио' ? 'time' : 'weight';
});

// Секундомер тренировки
setInterval(() => {
  const el = $('#elapsed');
  if (el && state.active) el.textContent = fmtDuration(Date.now() - new Date(state.active.start));
}, 1000);

render();
(async () => {
  if (await restoreFromBackupStore()) render();
  else save(); // создаём запасную копию для уже существующих данных
  await Promise.all([loadPhotos(), loadVideoIds()]);
  render();
  if (state.workouts.length) requestPersist();
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
