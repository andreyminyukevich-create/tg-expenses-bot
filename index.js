import "dotenv/config";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SCRIPT_URL = process.env.SCRIPT_URL;
const TOKEN = process.env.TOKEN;
const TIMEZONE = process.env.TIMEZONE || "Europe/Amsterdam";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!SCRIPT_URL) throw new Error("SCRIPT_URL missing");
if (!TOKEN) throw new Error("TOKEN missing");

const GROUPS = [
  "Поставщику",
  "Зарплата",
  "Возвраты",
  "Инструменты для работы",
  "Командировки",
  "Склад",
  "Налоги",
  "Доставка",
  "Разведка",
  "Подарки клиентам",
  "Бензин и то",
  "Транспортные компании",
  "Сайт",
  "ИИ",
];

// userId -> { screenMessageId, step, draft, lastNote }
const sessions = new Map();

function todayDDMMYYYY() {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());

  const dd = parts.find(p => p.type === "day")?.value;
  const mm = parts.find(p => p.type === "month")?.value;
  const yyyy = parts.find(p => p.type === "year")?.value;
  return `${dd}.${mm}.${yyyy}`;
}

async function api(payload) {
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, ...payload }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` };
  }
}

async function draftGet(userId) {
  return await api({ action: "draft_get", userId });
}
async function draftSet(userId, draft) {
  return await api({ action: "draft_set", userId, draft });
}
async function draftClear(userId) {
  return await api({ action: "draft_clear", userId });
}
async function appendRow(draft) {
  return await api({
    action: "append",
    type: draft.type,
    date: draft.date,
    amount: draft.amount,
    whom: draft.whom,
    group: draft.group,
    what: draft.what,
  });
}

function money(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toString() : "—";
}

function typeLabel(t) {
  return t === "expense" ? "Затраты" : t === "revenue" ? "Выручка" : "—";
}

function promptLine(step, d) {
  if (!d?.type) return "Нажмите «Внести транзакцию».";
  if (step === "amount") {
    return d.type === "revenue"
      ? "Какую сумму вы получили?"
      : "Какую сумму вы потратили?";
  }
  if (step === "whom") {
    const a = money(d.amount);
    return d.type === "revenue"
      ? `Кто заплатил вам ${a}?`
      : `Кому вы заплатили ${a}?`;
  }
  if (step === "group") return "Выберите группу.";
  if (step === "what") return "За что?";
  return "—";
}

function screenText(st) {
  const d = st?.draft || {};
  const date = d.date || todayDDMMYYYY();

  const lines = [];
  lines.push(`**Транзакция**`);
  lines.push(`Тип: **${typeLabel(d.type)}**`);
  lines.push(`Дата: **${date}**`);
  lines.push(`Сумма: **${d.amount != null ? money(d.amount) : "—"}**`);
  lines.push(`Контрагент: **${d.whom || "—"}**`);
  lines.push(`Группа: **${d.type === "expense" ? (d.group || "—") : "—"}**`);
  lines.push(`За что: **${d.type === "expense" ? (d.what || "—") : "—"}**`);
  lines.push("");
  if (st.lastNote) lines.push(`✅ ${st.lastNote}\n`);
  lines.push(`➡️ ${promptLine(st.step, d)}`);

  return lines.join("\n");
}

function kbMain(hasDraft) {
  const rows = [];
  rows.push([Markup.button.callback("Внести транзакцию", "start")]);
  if (hasDraft) rows.push([Markup.button.callback("Продолжить", "resume"), Markup.button.callback("Сбросить", "reset")]);
  return Markup.inlineKeyboard(rows);
}

function kbType() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Затраты", "t:expense"), Markup.button.callback("Выручка", "t:revenue")],
    [Markup.button.callback("Сбросить", "reset")],
  ]);
}

function kbGroups() {
  const rows = [];
  for (let i = 0; i < GROUPS.length; i += 2) {
    const a = GROUPS[i];
    const b = GROUPS[i + 1];
    const row = [Markup.button.callback(a, `g:${i}`)];
    if (b) row.push(Markup.button.callback(b, `g:${i + 1}`));
    rows.push(row);
  }
  rows.push([Markup.button.callback("Сбросить", "reset")]);
  return Markup.inlineKeyboard(rows);
}

async function tryDeleteUserMessage(ctx) {
  try { await ctx.deleteMessage(); } catch {}
}

function nextStep(d) {
  if (!d?.type) return "type";
  if (d.amount == null) return "amount";
  if (!d.whom) return "whom";
  if (d.type === "expense" && !d.group) return "group";
  if (d.type === "expense" && !d.what) return "what";
  return null;
}

async function ensureScreen(ctx) {
  const userId = String(ctx.from.id);
  let st = sessions.get(userId);

  if (!st) {
    const r = await draftGet(userId);
    const saved = r.ok ? r.draft : null;

    // saved ожидаем как {draft, step}
    const draft = saved?.draft || null;
    const step = saved?.step || (draft ? nextStep(draft) : null);

    st = { screenMessageId: null, draft, step, lastNote: null };
    sessions.set(userId, st);
  }

  if (!st.screenMessageId) {
    const msg = await ctx.reply(screenText(st), {
      parse_mode: "Markdown",
      ...kbMain(!!st.draft),
    });
    st.screenMessageId = msg.message_id;
  }

  return st;
}

async function updateScreen(ctx, st, keyboard) {
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenMessageId,
      undefined,
      screenText(st),
      { parse_mode: "Markdown", ...keyboard }
    );
  } catch {
    st.screenMessageId = null;
    await ensureScreen(ctx);
  }
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const st = await ensureScreen(ctx);
  await updateScreen(ctx, st, kbMain(!!st.draft));
});

bot.on("callback_query", async (ctx) => {
  const userId = String(ctx.from.id);
  const data = ctx.callbackQuery.data || "";
  const st = await ensureScreen(ctx);

  const persist = async () => {
    await draftSet(userId, { draft: st.draft, step: st.step });
  };

  if (data === "start") {
    st.lastNote = null;
    st.draft = { date: todayDDMMYYYY() };
    st.step = "type";
    await persist();
    await ctx.answerCbQuery("Ок");
    await updateScreen(ctx, st, kbType());
    return;
  }

  if (data === "resume") {
    if (!st.draft) {
      await ctx.answerCbQuery("Нет черновика");
      await updateScreen(ctx, st, kbMain(false));
      return;
    }
    st.step = st.step || nextStep(st.draft);
    await persist();
    await ctx.answerCbQuery("Ок");
    if (!st.draft.type) return updateScreen(ctx, st, kbType());
    if (st.step === "group") return updateScreen(ctx, st, kbGroups());
    return updateScreen(ctx, st, kbMain(true));
  }

  if (data === "reset") {
    st.draft = null;
    st.step = null;
    st.lastNote = null;
    await draftClear(userId);
    await ctx.answerCbQuery("Сброшено");
    await updateScreen(ctx, st, kbMain(false));
    return;
  }

  if (data === "t:expense" || data === "t:revenue") {
    const type = data.split(":")[1];
    st.draft = st.draft || {};
    st.draft.type = type;
    st.draft.date = todayDDMMYYYY(); // всегда сегодня
    st.step = "amount";
    await persist();
    await ctx.answerCbQuery("Ок");
    await updateScreen(ctx, st, kbMain(true));
    return;
  }

  if (data.startsWith("g:")) {
    if (!st.draft || st.draft.type !== "expense") {
      await ctx.answerCbQuery("Нет активной операции");
      return;
    }
    const idx = Number(data.slice(2));
    if (!Number.isInteger(idx) || idx < 0 || idx >= GROUPS.length) {
      await ctx.answerCbQuery("Ошибка");
      return;
    }
    st.draft.group = GROUPS[idx];
    st.step = "what";
    await persist();
    await ctx.answerCbQuery("Ок");
    await updateScreen(ctx, st, kbMain(true));
    return;
  }

  await ctx.answerCbQuery("Ок");
});

bot.on("text", async (ctx) => {
  const userId = String(ctx.from.id);
  const st = await ensureScreen(ctx);
  const text = ctx.message.text.trim();

  if (!st.draft || !st.step || st.step === "type") {
    await tryDeleteUserMessage(ctx);
    await updateScreen(ctx, st, kbMain(!!st.draft));
    return;
  }

  const persist = async () => {
    await draftSet(userId, { draft: st.draft, step: st.step });
  };

  if (st.step === "amount") {
    const val = Number(text.replace(",", "."));
    if (!Number.isFinite(val)) {
      await tryDeleteUserMessage(ctx);
      await updateScreen(ctx, st, kbMain(true));
      return;
    }
    st.draft.amount = val;
    st.step = "whom";
    await persist();
    await tryDeleteUserMessage(ctx);
    await updateScreen(ctx, st, kbMain(true));
    return;
  }

  if (st.step === "whom") {
    st.draft.whom = text;

    if (st.draft.type === "expense") {
      st.step = "group";
      await persist();
      await tryDeleteUserMessage(ctx);
      await updateScreen(ctx, st, kbGroups());
      return;
    }

    // revenue: сохраняем
    await persist();
    await tryDeleteUserMessage(ctx);

    const r = await appendRow(st.draft);
    if (!r.ok) {
      await updateScreen(ctx, st, kbMain(true));
      return;
    }

    st.lastNote = `${st.draft.whom} внес ${money(st.draft.amount)} сегодня.`;
    st.draft = null;
    st.step = null;
    await draftClear(userId);
    await updateScreen(ctx, st, kbMain(false));
    return;
  }

  if (st.step === "what") {
    st.draft.what = text;
    await persist();
    await tryDeleteUserMessage(ctx);

    const r = await appendRow(st.draft);
    if (!r.ok) {
      await updateScreen(ctx, st, kbMain(true));
      return;
    }

    st.lastNote = `Записано сегодня: ${money(st.draft.amount)}.`;
    st.draft = null;
    st.step = null;
    await draftClear(userId);
    await updateScreen(ctx, st, kbMain(false));
    return;
  }

  await tryDeleteUserMessage(ctx);
  await updateScreen(ctx, st, kbMain(true));
});

bot.launch();
console.log("Bot started");
