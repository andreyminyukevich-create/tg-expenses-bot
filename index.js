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

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

// Массивы с шутками для разных ситуаций
const ERRORS = {
  invalidAmount: [
    "🤨 Это сумма или код от сейфа?",
    "😅 Я конечно умный, но это не похоже на деньги...",
    "🧐 Вы уверены, что это цифры? Попробуйте еще раз",
    "💸 Хм, что-то не то... Может, попробуем нормальную сумму?",
    "🤔 Либо я глупый, либо это не деньги. Скорее второе",
  ],
  tooLarge: [
    "😱 Воу-воу! Миллиард? Я конечно рад за вас, но давайте реальнее",
    "🚀 Космические суммы! Но давайте что-то до миллиарда",
    "💰 Ого! А может все-таки что-то поскромнее?",
    "🤑 Красиво, но нереально. Попробуйте меньше миллиарда",
  ],
  tooLong: [
    "📚 Роман «Война и мир» короче! Макс 500 символов, пожалуйста",
    "✍️ Вы написали целую поэму! Давайте покороче",
    "📖 Слишком много букв, я запутался. Короче, пожалуйста!",
    "🤯 Это же целое сочинение! Сократите до 500 символов",
  ],
  networkError: [
    "🌐 Интернет куда-то пропал... Попробуйте еще раз",
    "📡 Связь с космосом потеряна. Повторите попытку",
    "🔌 Что-то с сетью... Попробуем еще раз?",
    "🛰️ Хьюстон, у нас проблемы! Давайте по новой",
  ],
};

function randomError(type) {
  const msgs = ERRORS[type];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

function cleanOldSessions() {
  const now = Date.now();
  for (const [userId, st] of sessions.entries()) {
    if (now - (st.lastActivity || 0) > SESSION_TTL) {
      sessions.delete(userId);
    }
  }
}

setInterval(cleanOldSessions, 10 * 60 * 1000);

function htmlEscape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("/", "&#x2F;");
}

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

async function appendRow(d) {
  return await api({
    action: "append",
    type: d.type,
    date: d.date,
    amount: d.amount,
    whom: d.whom,
    group: d.group,
    what: d.what,
  });
}

function typeLabel(t) {
  return t === "expense" ? "Затраты" : t === "revenue" ? "Выручка" : "—";
}

function promptText(step, d) {
  if (!d?.type) return "Нажмите «Внести транзакцию».";
  
  if (step === "amount") {
    return d.type === "revenue" 
      ? "💰 Какую сумму вы получили?" 
      : "💸 Какую сумму вы потратили?";
  }
  
  if (step === "whom") {
    const a = d.amount ?? "—";
    return d.type === "revenue"
      ? `👤 От кого получили ${a}?`
      : `👤 Кому заплатили ${a}?`;
  }
  
  if (step === "group") return "📁 Выберите группу.";
  if (step === "what") return "📋 За что?";
  
  return "—";
}

function renderScreen(st) {
  const d = st.draft || {};
  const date = d.date || todayDDMMYYYY();

  const lines = [];
  lines.push(`<b>Транзакция</b>`);
  lines.push(`Тип: <b>${htmlEscape(typeLabel(d.type))}</b>`);
  lines.push(`Дата: <b>${htmlEscape(date)}</b>`);
  lines.push(`Сумма: <b>${htmlEscape(d.amount ?? "—")}</b>`);
  lines.push(`Контрагент: <b>${htmlEscape(d.whom || "—")}</b>`);
  lines.push(`Группа: <b>${htmlEscape(d.type === "expense" ? (d.group || "—") : "—")}</b>`);
  lines.push(`За что: <b>${htmlEscape(d.type === "expense" ? (d.what || "—") : "—")}</b>`);
  lines.push("");
  if (st.lastNote) lines.push(`✅ ${htmlEscape(st.lastNote)}\n`);
  lines.push(`➡️ ${htmlEscape(promptText(st.step, d))}`);

  return lines.join("\n");
}

function kbMain(hasDraft) {
  const rows = [[Markup.button.callback("Внести транзакцию", "start")]];
  if (hasDraft) {
    rows.push([
      Markup.button.callback("Продолжить", "resume"), 
      Markup.button.callback("Сбросить", "reset")
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

function kbType() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Затраты", "t:expense"), 
      Markup.button.callback("Выручка", "t:revenue")
    ],
    [Markup.button.callback("Сбросить", "reset")],
  ]);
}

function kbGroups() {
  const rows = [];
  for (let i = 0; i < GROUPS.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3 && i + j < GROUPS.length; j++) {
      row.push(Markup.button.callback(GROUPS[i + j], `g:${i + j}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback("Сбросить", "reset")]);
  return Markup.inlineKeyboard(rows);
}

function nextStep(d) {
  if (!d?.type) return "type";
  if (d.amount == null) return "amount";
  if (!d.whom) return "whom";
  if (d.type === "expense" && !d.group) return "group";
  if (d.type === "expense" && !d.what) return "what";
  return null;
}

function ensureState(ctx) {
  const userId = String(ctx.from.id);
  let st = sessions.get(userId);

  if (!st) {
    st = { screenId: null, draft: null, step: null, lastNote: null, lastActivity: Date.now() };
    sessions.set(userId, st);
  }
  
  st.lastActivity = Date.now();
  return st;
}

async function ensureScreen(ctx, st) {
  if (st.screenId) return;

  const msg = await ctx.reply(renderScreen(st), {
    parse_mode: "HTML",
    ...kbMain(!!st.draft),
  });
  st.screenId = msg.message_id;
}

async function updateScreen(ctx, st, keyboard) {
  await ensureScreen(ctx, st);
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      renderScreen(st),
      { parse_mode: "HTML", ...keyboard }
    );
  } catch {
    st.screenId = null;
    await ensureScreen(ctx, st);
  }
}

async function tryDeleteUserMessage(ctx) {
  try { await ctx.deleteMessage(); } catch {}
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const st = ensureState(ctx);
  await updateScreen(ctx, st, kbMain(!!st.draft));
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  const st = ensureState(ctx);

  if (data === "start") {
    st.lastNote = null;
    st.draft = { date: todayDDMMYYYY() };
    st.step = "type";
    await ctx.answerCbQuery();
    await updateScreen(ctx, st, kbType());
    return;
  }

  if (data === "resume") {
    if (!st.draft) {
      await ctx.answerCbQuery("🤷‍♂️ Нет черновика");
      await updateScreen(ctx, st, kbMain(false));
      return;
    }
    st.step = st.step || nextStep(st.draft);
    await ctx.answerCbQuery();
    if (!st.draft.type) return updateScreen(ctx, st, kbType());
    if (st.step === "group") return updateScreen(ctx, st, kbGroups());
    return updateScreen(ctx, st, kbMain(true));
  }

  if (data === "reset") {
    st.draft = null;
    st.step = null;
    st.lastNote = null;
    await ctx.answerCbQuery("🧹 Всё чисто!");
    await updateScreen(ctx, st, kbMain(false));
    return;
  }

  if (data === "t:expense" || data === "t:revenue") {
    const type = data.split(":")[1];
    st.draft = st.draft || {};
    st.draft.type = type;
    st.draft.date = todayDDMMYYYY();
    st.step = "amount";
    await ctx.answerCbQuery();
    await updateScreen(ctx, st, kbMain(true));
    return;
  }

  if (data.startsWith("g:")) {
    if (!st.draft || st.draft.type !== "expense") {
      await ctx.answerCbQuery("🤔 А что вносим-то?");
      return;
    }
    const idx = Number(data.slice(2));
    if (!Number.isInteger(idx) || idx < 0 || idx >= GROUPS.length) {
      await ctx.answerCbQuery("😵 Упс, ошибочка");
      return;
    }
    st.draft.group = GROUPS[idx];
    st.step = "what";
    await ctx.answerCbQuery();
    await updateScreen(ctx, st, kbMain(true));
    return;
  }

  await ctx.answerCbQuery();
});

bot.on("text", async (ctx) => {
  const st = ensureState(ctx);
  const text = ctx.message.text.trim();

  if (!st.draft || !st.step || st.step === "type") {
    await tryDeleteUserMessage(ctx);
    await updateScreen(ctx, st, kbMain(!!st.draft));
    return;
  }

  if (st.step === "amount") {
    const val = Number(text.replace(",", "."));
    
    if (!Number.isFinite(val)) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("invalidAmount"));
      setTimeout(() => updateScreen(ctx, st, kbMain(true)), 1500);
      return;
    }
    
    if (val <= 0 || val > 999999999) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLarge"));
      setTimeout(() => updateScreen(ctx, st, kbMain(true)), 1500);
      return;
    }
    
    st.draft.amount = val;
    st.step = "whom";
    await tryDeleteUserMessage(ctx);
    await updateScreen(ctx, st, kbMain(true));
    return;
  }

  if (st.step === "whom") {
    if (text.length > 500) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLong"));
      setTimeout(() => updateScreen(ctx, st, kbMain(true)), 1500);
      return;
    }
    
    st.draft.whom = text;

    if (st.draft.type === "expense") {
      st.step = "group";
      await tryDeleteUserMessage(ctx);
      await updateScreen(ctx, st, kbGroups());
      return;
    }

    await tryDeleteUserMessage(ctx);

    const r = await appendRow(st.draft);
    if (!r.ok) {
      st.lastNote = `❌ ${randomError("networkError")}`;
      await updateScreen(ctx, st, kbMain(true));
      return;
    }

    st.lastNote = `${st.draft.whom} внес ${st.draft.amount} сегодня.`;
    st.draft = null;
    st.step = null;
    await updateScreen(ctx, st, kbMain(false));
    return;
  }

  if (st.step === "what") {
    if (text.length > 500) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLong"));
      setTimeout(() => updateScreen(ctx, st, kbMain(true)), 1500);
      return;
    }
    
    st.draft.what = text;
    await tryDeleteUserMessage(ctx);

    const r = await appendRow(st.draft);
    if (!r.ok) {
      st.lastNote = `❌ ${randomError("networkError")}`;
      await updateScreen(ctx, st, kbMain(true));
      return;
    }

    st.lastNote = `Записано сегодня: ${st.draft.amount}.`;
    st.draft = null;
    st.step = null;
    await updateScreen(ctx, st, kbMain(false));
    return;
  }

  await tryDeleteUserMessage(ctx);
  await updateScreen(ctx, st, kbMain(true));
});

bot.launch();
console.log("Bot started");
