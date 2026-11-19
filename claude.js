'use strict';

/* ================== Вкладка «Claude» ==================
   Связь с Claude без сервера и ключей: приложение готовит текст (статистику или запрос на план),
   вы отправляете его в Claude, а ответ с планом вставляете обратно — приложение само создаёт
   тренировочные дни с целевыми подходами, повторами, весом и отдыхом. */

const CLAUDE_URL = 'https://claude.ai/new';
const GOALS = ['Набор мышечной массы', 'Сила', 'Похудение / рельеф', 'Общая форма и здоровье', 'Выносливость'];
const LEVELS = ['Новичок (до 6 месяцев)', 'Средний (0,5–2 года)', 'Продвинутый (2+ года)'];
const PERIODS = [[28, '4 недели'], [91, '3 месяца'], [0, 'Всё время']];

let claudePeriod = 28;
let outgoingText = '';
let parsedPlan = null;

TITLES.claude = 'Claude';
VIEWS.claude = () => viewClaude();

const profile = () => (state.profile ||= { goal: GOALS[0], level: LEVELS[0], days: '3', duration: '60' });

/* ---------- Экран ---------- */

function viewClaude() {
  const pr = profile();
  const opt = (list, val) => list.map(v => `<option ${v === val ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const plan = state.plan;
  const planDays = plan ? state.templates.filter(t => t.planId === plan.id) : [];

  return `
    <div class="card claude-intro">
      <b>Claude — ваш онлайн-тренер.</b>
      <div class="muted">Отправьте ему статистику для разбора или попросите составить план, а готовый план загрузите обратно в приложение.</div>
    </div>

    ${plan ? `
    <div class="section-title">Текущий план</div>
    <div class="card">
      <div class="row between"><h3 style="margin:0">${esc(plan.name)}</h3><span class="badge plan">План</span></div>
      <div class="muted">Загружен ${fmtDateShort(plan.created)}${plan.weeks ? ` · рассчитан на ${plan.weeks} нед.` : ''}</div>
      ${plan.notes ? `<p class="plan-notes">${esc(plan.notes)}</p>` : ''}
      ${planDays.map(t => `
        <div class="list-item">
          <div class="grow"><div>${esc(t.name)}</div><div class="muted">${t.exIds.map(exName).map(esc).join(', ')}</div></div>
          <button class="btn small primary" data-action="plan-start" data-id="${t.id}">Начать</button>
        </div>`).join('')}
      <button class="btn danger small" data-action="plan-delete">Удалить план</button>
    </div>` : ''}

    <div class="section-title">1. О вас</div>
    <div class="card stack">
      <div><label>Цель</label><select data-profile="goal">${opt(GOALS, pr.goal)}</select></div>
      <div><label>Опыт</label><select data-profile="level">${opt(LEVELS, pr.level)}</select></div>
      <div class="row">
        <div class="grow"><label>Тренировок в неделю</label><select data-profile="days">${opt(['2', '3', '4', '5', '6'], pr.days)}</select></div>
        <div class="grow"><label>Длительность, мин</label><input inputmode="numeric" data-profile="duration" value="${esc(pr.duration || '')}"></div>
      </div>
      <div><label>О себе (возраст, рост, вес)</label><input data-profile="about" value="${esc(pr.about || '')}" placeholder="Например: 45 лет, 180 см, 85 кг"></div>
      <div><label>Ограничения, травмы</label><input data-profile="limits" value="${esc(pr.limits || '')}" placeholder="Например: болит поясница, не делаю становую"></div>
      <div><label>Пожелания</label><input data-profile="wishes" value="${esc(pr.wishes || '')}" placeholder="Например: больше спины, в зале нет штанги"></div>
      <div class="muted" style="font-size:13px">Сохраняется автоматически и попадает в запросы к Claude.</div>
    </div>

    <div class="section-title">2. Отправить в Claude</div>
    <div class="card stack">
      <div><b>📊 Разбор тренировок</b><div class="muted">Claude оценит прогресс, баланс групп мышц и даст советы.</div></div>
      <div class="chips">${PERIODS.map(([d, label]) => `<button class="chip ${d === claudePeriod ? 'active' : ''}" data-action="claude-period" data-d="${d}">${label}</button>`).join('')}</div>
      <button class="btn block" data-action="claude-stats" ${state.workouts.length ? '' : 'disabled'}>Подготовить статистику</button>
      ${state.workouts.length ? '' : '<div class="muted" style="font-size:13px">Сначала проведите хотя бы одну тренировку.</div>'}
    </div>
    <div class="card stack">
      <div><b>🗓 ${plan ? 'Обновить план' : 'Составить план'}</b><div class="muted">${plan
        ? 'Claude скорректирует текущий план с учётом ваших результатов.'
        : 'Claude составит программу под вашу цель и ответит в формате, который понимает приложение.'}</div></div>
      <button class="btn primary block" data-action="claude-plan">Подготовить запрос на план</button>
    </div>

    <div class="section-title">3. Загрузить план от Claude</div>
    <div class="card stack">
      <div class="muted">Скопируйте ответ Claude целиком (или только блок с кодом) и вставьте сюда.</div>
      <textarea id="plan-input" rows="5" placeholder='{"gymPlan": 1, "name": "…", "days": [ … ] }'></textarea>
      <div class="row">
        <button class="btn grow" data-action="plan-paste">📋 Вставить</button>
        <button class="btn grow" data-action="plan-file">📄 Из файла</button>
      </div>
      <button class="btn primary block" data-action="plan-check">Проверить и загрузить</button>
    </div>`;
}

/* ---------- Текст статистики ---------- */

const setsLine = (exId, sets) => sets.map(s => fmtSetShort(exId, s)).join(', ');

function profileText() {
  const pr = profile();
  return [
    `- Цель: ${pr.goal}`,
    `- Опыт: ${pr.level}`,
    `- Тренировок в неделю: ${pr.days}, длительность ~${pr.duration || 60} мин`,
    pr.about && `- О себе: ${pr.about}`,
    pr.limits && `- Ограничения/травмы: ${pr.limits}`,
    pr.wishes && `- Пожелания: ${pr.wishes}`,
  ].filter(Boolean).join('\n');
}

function periodWorkouts(days) {
  if (!days) return state.workouts.slice();
  const from = Date.now() - days * 864e5;
  return state.workouts.filter(w => new Date(w.start) >= from);
}

function exerciseSummary(ws) {
  const byEx = new Map();
  for (const w of ws) for (const it of w.items) {
    if (!doneSets(it).length) continue;
    if (!byEx.has(it.exId)) byEx.set(it.exId, []);
    byEx.get(it.exId).push({ date: w.start, sets: doneSets(it) });
  }
  const lines = [];
  for (const [exId, list] of byEx) {
    const ex = exById(exId);
    const name = ex ? `${ex.name} (${ex.group})` : 'Удалённое упражнение';
    const last = list[list.length - 1];
    if (isTime(exId)) {
      const total = list.reduce((a, x) => a + x.sets.reduce((b, s) => b + setSeconds(s), 0), 0);
      lines.push(`- ${name}: ${list.length} трен., всего ${fmtTime(total)}; последний раз ${fmtDateShort(last.date)}: ${setsLine(exId, last.sets)}`);
      continue;
    }
    const best1rm = x => Math.max(...x.sets.map(s => e1rm(num(s.w), num(s.r))));
    let best = null;
    for (const x of list) for (const s of x.sets) {
      const v = e1rm(num(s.w), num(s.r));
      if (!best || v > best.v) best = { v, s, date: x.date };
    }
    const first = best1rm(list[0]), lastV = best1rm(last);
    lines.push(`- ${name}: ${list.length} трен.; лучший подход ${fmtSet(exId, best.s)} (${fmtDateShort(best.date)}, расч. 1ПМ ≈ ${fmtNum(best.v)} кг)`
      + (list.length > 1 ? `; расч. 1ПМ: ${fmtNum(first)} → ${fmtNum(lastV)} кг` : '')
      + `; последний раз ${fmtDateShort(last.date)}: ${setsLine(exId, last.sets)}`);
  }
  return lines.join('\n');
}

function overviewText(ws, days) {
  if (!ws.length) return 'Тренировок за период нет.';
  const sinceFirst = (Date.now() - new Date(ws[0].start)) / 864e5;
  const span = Math.max(7, days ? Math.min(days, sinceFirst) : sinceFirst);
  const mins = ws.map(w => (new Date(w.end) - new Date(w.start)) / 60000);
  const vol = ws.reduce((a, w) => a + workoutVolume(w), 0);
  const groups = {};
  for (const w of ws) for (const it of w.items) {
    const g = exById(it.exId)?.group || 'Другое';
    groups[g] = (groups[g] || 0) + (isTime(it.exId) ? 0 : doneSets(it).length);
  }
  return [
    `- Тренировок: ${ws.length} (в среднем ${fmtNum(ws.length / (span / 7))} в неделю)`,
    `- Средняя длительность: ${Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)} мин`,
    `- Общий тоннаж: ${fmtNum(vol)} кг`,
    `- Рабочих подходов по группам мышц: ${Object.entries(groups).filter(([, n]) => n).map(([g, n]) => `${g} ${n}`).join(', ') || '—'}`,
  ].join('\n');
}

function journalText(ws) {
  return ws.map(w => {
    const head = `### ${fmtDate(w.start)} — ${w.name}, ${fmtMinutes(new Date(w.end) - new Date(w.start))}`;
    const items = w.items.map(it => `- ${exName(it.exId)}: ${setsLine(it.exId, doneSets(it))}`).join('\n');
    return [head, items, w.note && `Заметка: ${w.note}`].filter(Boolean).join('\n');
  }).join('\n\n');
}

function planSummaryText() {
  if (!state.plan) return '';
  const days = state.templates.filter(t => t.planId === state.plan.id);
  return `## Мой текущий план: «${state.plan.name}» (загружен ${fmtDateShort(state.plan.created)})\n`
    + days.map(t => `**${t.name}**: ` + t.exIds.map(id => `${exName(id)} ${t.targets?.[id] ? targetText(id, t.targets[id]) : ''}`.trim()).join('; ')).join('\n');
}

function buildStatsText() {
  const ws = periodWorkouts(claudePeriod);
  const label = PERIODS.find(([d]) => d === claudePeriod)[1].toLowerCase();
  return `Ты — опытный тренер по силовым тренировкам. Ниже моя статистика из приложения-дневника «Мой зал» за ${label}.
Проанализируй её и ответь по-русски:
1. Как идёт прогресс по основным упражнениям, где застой.
2. Сбалансированы ли группы мышц и частота тренировок для моей цели.
3. Что конкретно изменить: упражнения, подходы/повторы, веса, отдых, восстановление.
Пиши кратко и по делу.

## Обо мне
${profileText()}

## Сводка
${overviewText(ws, claudePeriod)}

## По упражнениям
${exerciseSummary(ws) || '—'}

${planSummaryText()}

## Дневник тренировок
${journalText(ws)}
`.replace(/\n{3,}/g, '\n\n');
}

/* ---------- Запрос на план ---------- */

const PLAN_FORMAT = `{
  "gymPlan": 1,
  "name": "Название плана",
  "weeks": 6,
  "notes": "Общие указания: разминка, как повышать веса, что делать при неудаче",
  "days": [
    {
      "name": "День A — Грудь и трицепс",
      "exercises": [
        { "name": "Жим штанги лёжа", "group": "Грудь", "kind": "weight", "sets": 4, "reps": "8-10", "weight": 60, "rest": 120, "note": "Лопатки сведены" },
        { "name": "Беговая дорожка", "group": "Кардио", "kind": "time", "sets": 1, "minutes": 15, "note": "Заминка, пульс 120–130" }
      ]
    }
  ]
}`;

function buildPlanText() {
  const recent = periodWorkouts(56);
  const names = state.exercises.slice().sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.name.localeCompare(b.name, 'ru'))
    .map(e => `${e.name} (${e.group}${e.kind === 'time' ? ', на время' : ''})`).join('; ');
  return `Ты — опытный тренер по силовым тренировкам. ${state.plan ? 'Скорректируй мой текущий план тренировок' : 'Составь мне план тренировок в зале'} с учётом данных ниже.
Сначала коротко (5–10 строк) объясни логику плана и как прогрессировать. Затем дай план ОДНИМ блоком кода \`\`\`json строго в формате ниже — я загружу его в приложение-дневник.

Правила формата:
- "days" — тренировочные дни (сколько тренировок в неделю, столько и дней), в "name" дня — понятное название.
- "name" упражнения — бери ТОЧНО из списка моих упражнений, если подходит; новое упражнение называй коротко по-русски.
- "group" — одно из: ${GROUPS.join(', ')}.
- "kind": "weight" (подходы × повторы с весом) или "time" (кардио, планка — по времени).
- Для "weight": "sets" — число подходов, "reps" — строка ("8-10" или "12"), "weight" — рабочий вес в кг числом (подбери по моей статистике; если данных нет — null), "rest" — отдых в секундах.
- Для "time": "sets" — число отрезков, "minutes" — минут на отрезок.
- "note" — короткая подсказка по технике или выполнению (можно пустую строку).
- Только корректный JSON: двойные кавычки, без комментариев.

${PLAN_FORMAT}

## Обо мне
${profileText()}

## Мои результаты за последние 8 недель
${recent.length ? `${overviewText(recent, 56)}\n\n${exerciseSummary(recent)}` : 'Пока нет записанных тренировок — подбери стартовые веса осторожно или поставь null.'}

${planSummaryText()}

## Мои упражнения (названия)
${names}
`.replace(/\n{3,}/g, '\n\n');
}

/* ---------- Отправка ---------- */

function openOutgoing(title, text) {
  outgoingText = text;
  openModal(`
    <h2>${title}</h2>
    <ol class="steps">
      <li>Нажмите <b>«Скопировать и открыть Claude»</b>.</li>
      <li>В новом чате вставьте текст (долгое нажатие → «Вставить») и отправьте.</li>
    </ol>
    <textarea class="outgoing" readonly rows="9">${esc(text)}</textarea>
    <div class="muted" style="font-size:13px;margin:4px 0 10px">${text.length.toLocaleString('ru-RU')} символов</div>
    <a class="btn primary block" href="${CLAUDE_URL}" target="_blank" rel="noopener" data-action="claude-copy-open">📋 Скопировать и открыть Claude</a>
    <div class="row" style="margin-top:8px">
      <button class="btn grow" data-action="claude-copy">Только скопировать</button>
      ${navigator.share ? '<button class="btn grow" data-action="claude-share">📤 Поделиться</button>' : ''}
    </div>
    <button class="btn block" style="margin-top:8px" data-action="close-modal">Закрыть</button>`);
}

function copyText(text) {
  // writeText вызываем сразу в обработчике нажатия — иначе iPhone не даст доступ к буферу
  const fallback = () => {
    const ta = $('#sheet textarea.outgoing');
    if (!ta) return false;
    ta.removeAttribute('readonly'); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.setAttribute('readonly', ''); ta.blur();
    return ok;
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, fallback);
  return Promise.resolve(fallback());
}

function flash(selector, label) {
  const el = $(selector);
  if (!el) return;
  const old = el.textContent;
  el.textContent = label;
  setTimeout(() => { if (el.isConnected) el.textContent = old; }, 1800);
}

/* ---------- Разбор ответа Claude ---------- */

const normName = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

function extractJson(text) {
  const t = String(text || '');
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1]).find(b => b.includes('days'));
  const raw = fenced || t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  if (!raw.trim()) throw new Error('В тексте не найден план (блок с фигурными скобками).');
  // Пробуем как есть, затем исправляем частые огрехи копирования: лишние запятые, «умные» кавычки
  const fixes = [r => r, r => r.replace(/,\s*([}\]])/g, '$1'), r => r.replace(/[“”„]/g, '"').replace(/,\s*([}\]])/g, '$1')];
  let err;
  for (const fix of fixes) { try { return JSON.parse(fix(raw)); } catch (e) { err = e; } }
  throw new Error('План повреждён — возможно, скопирован не целиком. ' + err.message);
}

function parsePlan(text) {
  const data = extractJson(text);
  const days = Array.isArray(data.days) ? data.days : Array.isArray(data) ? data : null;
  if (!days?.length) throw new Error('В плане нет тренировочных дней ("days").');
  const out = {
    name: String(data.name || 'План от Claude').slice(0, 80),
    notes: String(data.notes || ''),
    weeks: Math.round(num(data.weeks)) || null,
    days: days.map((d, i) => ({
      name: String(d.name || `День ${i + 1}`).slice(0, 80),
      exercises: (d.exercises || []).filter(e => e && e.name).map(e => {
        const kind = e.kind === 'time' || e.group === 'Кардио' ? 'time' : 'weight';
        const existing = state.exercises.find(x => normName(x.name) === normName(e.name));
        return {
          name: existing ? existing.name : String(e.name).slice(0, 60),
          existingId: existing?.id || null,
          group: existing?.group || (GROUPS.includes(e.group) ? e.group : 'Другое'),
          kind: existing?.kind || kind,
          target: {
            sets: Math.max(1, Math.min(20, Math.round(num(e.sets)) || (kind === 'time' ? 1 : 3))),
            reps: e.reps != null && e.reps !== '' ? String(e.reps) : '',
            weight: e.weight == null || e.weight === '' || !num(e.weight) ? null : num(e.weight),
            rest: Math.round(num(e.rest)) || null,
            minutes: e.minutes != null ? num(e.minutes) || null : null,
            note: String(e.note || ''),
          },
        };
      }),
    })).filter(d => d.exercises.length),
  };
  if (!out.days.length) throw new Error('В днях плана нет упражнений.');
  return out;
}

function previewPlan(plan) {
  parsedPlan = plan;
  const newCount = new Set(plan.days.flatMap(d => d.exercises.filter(e => !e.existingId).map(e => normName(e.name)))).size;
  openModal(`
    <h2>${esc(plan.name)}</h2>
    <p class="muted">${plan.days.length} трен. дн.${plan.weeks ? ` · ${plan.weeks} нед.` : ''}${newCount ? ` · новых упражнений: ${newCount}` : ''}</p>
    ${plan.notes ? `<p class="plan-notes">${esc(plan.notes)}</p>` : ''}
    ${plan.days.map(d => `
      <div class="card">
        <h3>${esc(d.name)}</h3>
        ${d.exercises.map(e => `
          <div class="plan-ex">
            <div class="row between"><span>${esc(e.name)} ${e.existingId ? '' : '<span class="badge">новое</span>'}</span>
            <span class="muted">${esc(e.kind === 'time'
              ? [e.target.sets > 1 ? `${e.target.sets}×` : '', e.target.minutes ? `${e.target.minutes} мин` : ''].join('')
              : `${e.target.sets}×${e.target.reps || '?'}${e.target.weight != null ? ` · ${fmtNum(e.target.weight)} кг` : ''}`)}</span></div>
            ${e.target.note ? `<div class="muted" style="font-size:13px">${esc(e.target.note)}</div>` : ''}
          </div>`).join('')}
      </div>`).join('')}
    ${state.plan ? `<p class="muted">Текущий план «${esc(state.plan.name)}» будет заменён. История тренировок сохранится.</p>` : ''}
    <button class="btn primary block" data-action="plan-apply">✅ Загрузить в приложение</button>
    <button class="btn block" style="margin-top:8px" data-action="close-modal">Отмена</button>`);
}

function applyPlan(plan) {
  if (state.plan) state.templates = state.templates.filter(t => t.planId !== state.plan.id);
  const planId = uid();
  const created = [];
  const templates = plan.days.map(d => {
    const exIds = [], targets = {};
    for (const e of d.exercises) {
      let ex = exById(e.existingId) || state.exercises.find(x => normName(x.name) === normName(e.name));
      if (!ex) {
        ex = { id: uid(), name: e.name, group: e.group, kind: e.kind };
        state.exercises.push(ex);
        created.push(ex.name);
      }
      if (exIds.includes(ex.id)) continue;
      exIds.push(ex.id);
      targets[ex.id] = e.target;
    }
    return { id: uid(), name: d.name, exIds, targets, planId };
  });
  state.templates = [...templates, ...state.templates];
  state.plan = { id: planId, name: plan.name, notes: plan.notes, weeks: plan.weeks, created: new Date().toISOString() };
  save();
  parsedPlan = null;
  openModal(`
    <h2>План загружен ✅</h2>
    <p>На вкладке «Тренировка» появились дни плана — нажмите на нужный, чтобы начать.</p>
    <p class="muted">В каждом упражнении серым подсказаны вес и повторы из плана. Нажмите ✓, чтобы принять их, или впишите свои числа.</p>
    ${created.length ? `<p class="muted">Добавлены новые упражнения: ${created.map(esc).join(', ')}. Видео техники для них можно найти кнопкой ▶.</p>` : ''}
    <button class="btn primary block" data-action="plan-go">К тренировкам</button>`);
}

/* ---------- Действия ---------- */

Object.assign(actions, {
  'claude-period': d => { claudePeriod = +d.d; render(); },
  'claude-stats': () => openOutgoing('Статистика для Claude', buildStatsText()),
  'claude-plan': () => openOutgoing(state.plan ? 'Запрос на обновление плана' : 'Запрос на план', buildPlanText()),
  'claude-copy-open': () => { copyText(outgoingText); }, // ссылка откроется сама
  'claude-copy': () => copyText(outgoingText).then(ok => flash('[data-action=claude-copy]', ok ? 'Скопировано ✓' : 'Не вышло — выделите текст вручную')),
  'claude-share': async () => {
    try { await navigator.share({ text: outgoingText }); }
    catch (e) { if (e.name !== 'AbortError') alert('Не получилось поделиться. Используйте «Скопировать».'); }
  },
  'plan-paste': async () => {
    try { $('#plan-input').value = await navigator.clipboard.readText(); }
    catch { alert('Нет доступа к буферу обмена. Вставьте текст в поле вручную: долгое нажатие → «Вставить».'); }
  },
  'plan-file': () => {
    const input = filePicker('.json,.txt,.md,application/json,text/plain');
    input.onchange = async () => {
      const f = input.files[0];
      input.remove();
      if (f) $('#plan-input').value = await f.text();
    };
    input.click();
  },
  'plan-check': () => {
    const text = $('#plan-input').value;
    if (!text.trim()) return alert('Сначала вставьте ответ Claude с планом.');
    try { previewPlan(parsePlan(text)); }
    catch (e) { alert(e.message + '\n\nПопросите Claude: «Пришли план ещё раз одним блоком json по формату».'); }
  },
  'plan-apply': () => { if (parsedPlan) applyPlan(parsedPlan); },
  'plan-go': () => { closeModal(); setTab('workout'); },
  'plan-start': d => {
    if (state.active) return alert('Сначала завершите текущую тренировку.');
    actions['start-template'](d);
    setTab('workout');
  },
  'plan-delete': () => {
    if (!confirm(`Удалить план «${state.plan.name}»? Дни плана исчезнут из шаблонов, история тренировок останется.`)) return;
    state.templates = state.templates.filter(t => t.planId !== state.plan.id);
    delete state.plan;
    save(); render();
  },
});

// Профиль сохраняем при вводе
document.addEventListener('input', e => {
  const key = e.target.dataset?.profile;
  if (!key) return;
  profile()[key] = e.target.value;
  save();
});
