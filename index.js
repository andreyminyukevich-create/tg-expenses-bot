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

function formatNumber(num) {
  return new Intl.NumberFormat("ru-RU").format(num);
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

async function getStats(period) {
  return await api({
    action: "stats",
    period: period,
  });
}

async function getTransactionsToday(type) {
  return await api({
    action: "transactions_today",
    type: type,
  });
}

async function getTransactionsByGroup(group, period) {
  return await api({
    action: "transactions_by_group",
    group: group,
    period: period,
  });
}

async function getTopPayers(period, limit) {
  return await api({
    action: "top_payers",
    period: period,
    limit: limit || 20,
  });
}

function promptText(step, d) {
  if (step === "type") return "Выберите тип транзакции:";
  
  if (step === "amount") {
    return d.type === "revenue" 
      ? "💰 Какую сумму вы получили?" 
      : "💸 Какую сумму вы потратили?";
  }
  
  if (step === "whom") {
    const a = formatNumber(d.amount);
    return d.type === "revenue"
      ? `👤 От кого получили ${a} ₽?`
      : `👤 Кому заплатили ${a} ₽?`;
  }
  
  if (step === "group") return "📁 Выберите группу:";
  if (step === "what") return "📋 За что?";
  
  return "";
}

async function renderMainScreen() {
  const [todayStats, monthStats] = await Promise.all([
    getStats("today"),
    getStats("month")
  ]);

  const lines = [];
  
  if (todayStats.ok) {
    const tRevenue = todayStats.revenue || 0;
    const tExpense = todayStats.expense || 0;
    const tBalance = tRevenue - tExpense;
    const tSign = tBalance >= 0 ? "+" : "";
    
    lines.push(`📊 <b>ИТОГИ ЗА СЕГОДНЯ (${todayStats.date || todayDDMMYYYY()})</b>`);
    lines.push(`💰 Выручка: ${formatNumber(tRevenue)} ₽`);
    lines.push(`💸 Затраты: ${formatNumber(tExpense)} ₽`);
    lines.push(`━━━━━━━━━━━━━━━━━`);
    lines.push(`📈 Баланс: ${tSign}${formatNumber(tBalance)} ₽`);
    lines.push("");
  }
  
  if (monthStats.ok) {
    const mRevenue = monthStats.revenue || 0;
    const mExpense = monthStats.expense || 0;
    const mBalance = mRevenue - mExpense;
    const mSign = mBalance >= 0 ? "+" : "";
    
    lines.push(`📅 <b>ИТОГИ ЗА ${(monthStats.monthName || "МЕСЯЦ").toUpperCase()}</b>`);
    lines.push(`💰 Выручка: ${formatNumber(mRevenue)} ₽`);
    lines.push(`💸 Затраты: ${formatNumber(mExpense)} ₽`);
    lines.push(`━━━━━━━━━━━━━━━━━`);
    lines.push(`📈 Баланс: ${mSign}${formatNumber(mBalance)} ₽`);
    
    if (monthStats.topGroups && monthStats.topGroups.length > 0) {
      lines.push("");
      lines.push(`🔝 <b>Топ затрат:</b>`);
      monthStats.topGroups.forEach((g, i) => {
        lines.push(`${i + 1}. ${htmlEscape(g.group)} — ${formatNumber(g.amount)} ₽`);
      });
    }
  }

  return lines.join("\n");
}

function kbMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Внести транзакцию", "start")],
    [Markup.button.callback("📊 Аналитика", "analytics")]
  ]);
}

function kbAnalytics() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Затраты за сегодня", "analytics:expenses_today")],
    [Markup.button.callback("Поступления за сегодня", "analytics:revenue_today")],
    [Markup.button.callback("Затраты по группам", "analytics:by_group")],
    [Markup.button.callback("Топ плательщиков", "analytics:top_payers")],
    [Markup.button.callback("← Назад", "back_to_main")]
  ]);
}

function kbType() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Затраты", "t:expense"), 
      Markup.button.callback("Выручка", "t:revenue")
    ],
    [Markup.button.callback("Отмена", "cancel")],
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
  rows.push([Markup.button.callback("Отмена", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function kbGroupsAnalytics() {
  const rows = [];
  for (let i = 0; i < GROUPS.length; i += 2) {
    const row = [];
    for (let j = 0; j < 2 && i + j < GROUPS.length; j++) {
      row.push(Markup.button.callback(GROUPS[i + j], `analytics:group:${i + j}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback("← Назад", "analytics")]);
  return Markup.inlineKeyboard(rows);
}

function kbTopPayersPeriod() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("За сегодня", "analytics:top:today")],
    [Markup.button.callback("За неделю", "analytics:top:week")],
    [Markup.button.callback("За месяц", "analytics:top:month")],
    [Markup.button.callback("← Назад", "analytics")]
  ]);
}

function kbCancel() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Отмена", "cancel")]
  ]);
}

function kbBackToAnalytics() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("← Назад", "analytics")]
  ]);
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
    st = { screenId: null, draft: null, step: null, lastActivity: Date.now() };
    sessions.set(userId, st);
  }
  
  st.lastActivity = Date.now();
  return st;
}

async function showMainScreen(ctx, st) {
  const text = await renderMainScreen();
  
  // Удаляем старый экран если был
  if (st.screenId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId);
    } catch {}
    st.screenId = null;
  }
  
  // Создаём новый (всегда последний)
  const msg = await ctx.reply(text, {
    parse_mode: "HTML",
    ...kbMain(),
  });
  st.screenId = msg.message_id;
}
async function showAnalyticsMenu(ctx, st) {
  const text = "📊 <b>АНАЛИТИКА</b>\n\nВыберите тип отчёта:";
  
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      text,
      { parse_mode: "HTML", ...kbAnalytics() }
    );
  } catch {
    const msg = await ctx.reply(text, {
      parse_mode: "HTML",
      ...kbAnalytics(),
    });
    st.screenId = msg.message_id;
  }
}

async function showPrompt(ctx, st, keyboard) {
  const text = promptText(st.step, st.draft);
  
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      text,
      { parse_mode: "HTML", ...keyboard }
    );
  } catch {
    const msg = await ctx.reply(text, {
      parse_mode: "HTML",
      ...keyboard,
    });
    st.screenId = msg.message_id;
  }
}

async function tryDeleteUserMessage(ctx) {
  try { await ctx.deleteMessage(); } catch {}
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const st = ensureState(ctx);
  await showMainScreen(ctx, st);
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  const st = ensureState(ctx);

  // === АНАЛИТИКА ===
  if (data === "analytics") {
    await ctx.answerCbQuery();
    await showAnalyticsMenu(ctx, st);
    return;
  }

  if (data === "back_to_main") {
    await ctx.answerCbQuery();
    await showMainScreen(ctx, st);
    return;
  }

  if (data === "analytics:expenses_today") {
    await ctx.answerCbQuery("⏳ Загружаю...");
    const r = await getTransactionsToday("expense");
    
    if (!r.ok || !r.transactions || r.transactions.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        st.screenId,
        undefined,
        "💸 <b>ЗАТРАТЫ ЗА СЕГОДНЯ</b>\n\nПусто",
        { parse_mode: "HTML", ...kbBackToAnalytics() }
      );
      return;
    }
    
    let total = 0;
    const lines = [`💸 <b>ЗАТРАТЫ ЗА СЕГОДНЯ (${r.date})</b>\n`];
    
    r.transactions.forEach((t, i) => {
      total += t.amount;
      const group = t.group ? ` — ${t.group}` : "";
      const what = t.what ? ` — ${t.what}` : "";
      lines.push(`${i + 1}. ${htmlEscape(t.whom)} — ${formatNumber(t.amount)} ₽${group}${what}`);
    });
    
    lines.push(`\n<b>Всего: ${formatNumber(total)} ₽</b>`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      lines.join("\n"),
      { parse_mode: "HTML", ...kbBackToAnalytics() }
    );
    return;
  }

  if (data === "analytics:revenue_today") {
    await ctx.answerCbQuery("⏳ Загружаю...");
    const r = await getTransactionsToday("revenue");
    
    if (!r.ok || !r.transactions || r.transactions.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        st.screenId,
        undefined,
        "💰 <b>ПОСТУПЛЕНИЯ ЗА СЕГОДНЯ</b>\n\nПусто",
        { parse_mode: "HTML", ...kbBackToAnalytics() }
      );
      return;
    }
    
    let total = 0;
    const lines = [`💰 <b>ПОСТУПЛЕНИЯ ЗА СЕГОДНЯ (${r.date})</b>\n`];
    
    r.transactions.forEach((t, i) => {
      total += t.amount;
      lines.push(`${i + 1}. ${htmlEscape(t.whom)} — ${formatNumber(t.amount)} ₽`);
    });
    
    lines.push(`\n<b>Всего: ${formatNumber(total)} ₽</b>`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      lines.join("\n"),
      { parse_mode: "HTML", ...kbBackToAnalytics() }
    );
    return;
  }

  if (data === "analytics:by_group") {
    await ctx.answerCbQuery();
    const text = "📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>\n\nВыберите группу:";
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      text,
      { parse_mode: "HTML", ...kbGroupsAnalytics() }
    );
    return;
  }

  if (data.startsWith("analytics:group:")) {
    const idx = Number(data.split(":")[2]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= GROUPS.length) {
      await ctx.answerCbQuery("Ошибка");
      return;
    }
    
    const group = GROUPS[idx];
    await ctx.answerCbQuery("⏳ Загружаю...");
    
    const r = await getTransactionsByGroup(group, "month");
    
    if (!r.ok || !r.transactions || r.transactions.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        st.screenId,
        undefined,
        `📁 <b>${htmlEscape(group).toUpperCase()}</b>\n\nНет транзакций за текущий месяц`,
        { parse_mode: "HTML", ...kbBackToAnalytics() }
      );
      return;
    }
    
    let total = 0;
    const lines = [`📁 <b>${htmlEscape(group).toUpperCase()}</b>\n`];
    
    r.transactions.forEach((t, i) => {
      total += t.amount;
      const what = t.what ? ` — ${t.what}` : "";
      lines.push(`${i + 1}. ${t.date} | ${htmlEscape(t.whom)} — ${formatNumber(t.amount)} ₽${what}`);
    });
    
    lines.push(`\n<b>Всего: ${formatNumber(total)} ₽</b>`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      lines.join("\n"),
      { parse_mode: "HTML", ...kbBackToAnalytics() }
    );
    return;
  }

  if (data === "analytics:top_payers") {
    await ctx.answerCbQuery();
    const text = "🏆 <b>ТОП ПЛАТЕЛЬЩИКОВ</b>\n\nВыберите период:";
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      text,
      { parse_mode: "HTML", ...kbTopPayersPeriod() }
    );
    return;
  }

  if (data.startsWith("analytics:top:")) {
    const period = data.split(":")[2];
    await ctx.answerCbQuery("⏳ Загружаю...");
    
    const r = await getTopPayers(period, 20);
    
    if (!r.ok || !r.payers || r.payers.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        st.screenId,
        undefined,
        `🏆 <b>ТОП ПЛАТЕЛЬЩИКОВ</b>\n\nНет данных за выбранный период`,
        { parse_mode: "HTML", ...kbBackToAnalytics() }
      );
      return;
    }
    
    const periodName = period === "today" ? "СЕГОДНЯ" : period === "week" ? "НЕДЕЛЮ" : "МЕСЯЦ";
    let grandTotal = 0;
    
    const lines = [`🏆 <b>ТОП-20 ПЛАТЕЛЬЩИКОВ ЗА ${periodName}</b>\n`];
    
    r.payers.forEach((p, i) => {
      grandTotal += p.total;
      const count = p.count > 1 ? ` (${p.count} платежей)` : "";
      lines.push(`${i + 1}. ${htmlEscape(p.name)} — ${formatNumber(p.total)} ₽${count}`);
    });
    
    lines.push(`\n<b>Всего от топ-${r.payers.length}: ${formatNumber(grandTotal)} ₽</b>`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      st.screenId,
      undefined,
      lines.join("\n"),
      { parse_mode: "HTML", ...kbBackToAnalytics() }
    );
    return;
  }

  // === ТРАНЗАКЦИИ ===
  if (data === "start") {
    st.draft = { date: todayDDMMYYYY() };
    st.step = "type";
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbType());
    return;
  }

  if (data === "cancel") {
    st.draft = null;
    st.step = null;
    await ctx.answerCbQuery("Отменено");
    await showMainScreen(ctx, st);
    return;
  }

  if (data === "t:expense" || data === "t:revenue") {
    const type = data.split(":")[1];
    st.draft = st.draft || {};
    st.draft.type = type;
    st.draft.date = todayDDMMYYYY();
    st.step = "amount";
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbCancel());
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
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  await ctx.answerCbQuery();
});

bot.on("text", async (ctx) => {
  const st = ensureState(ctx);
  const text = ctx.message.text.trim();

  // АВТООТЧЁТ
  if (text.startsWith("/auto_report:")) {
    const parts = text.split(":");
    if (parts.length < 2) return;
    
    const token = parts[1];
    if (token !== TOKEN) return;
    
    const r = await getStats("today");
    if (!r.ok) {
      await ctx.reply("❌ Ошибка получения данных");
      return;
    }
    
    const revenue = r.revenue || 0;
    const expense = r.expense || 0;
    const balance = revenue - expense;
    const sign = balance >= 0 ? "+" : "";
    
    const msg = `🌙 <b>Добрый вечер! Итоги дня:</b>

📅 ${r.date || todayDDMMYYYY()}
💰 Поступлений: ${formatNumber(revenue)} ₽
💸 Затрат: ${formatNumber(expense)} ₽
━━━━━━━━━━━━━━━━━
📈 Баланс дня: ${sign}${formatNumber(balance)} ₽`;

    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  // ОБЫЧНАЯ ЛОГИКА
  if (!st.draft || !st.step) {
    await tryDeleteUserMessage(ctx);
    return;
  }

  if (st.step === "amount") {
    const val = Number(text.replace(",", "."));
    
    if (!Number.isFinite(val)) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("invalidAmount"));
      return;
    }
    
    if (val <= 0 || val > 999999999) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLarge"));
      return;
    }
    
    st.draft.amount = val;
    st.step = "whom";
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (st.step === "whom") {
    if (text.length > 500) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLong"));
      return;
    }
    
    st.draft.whom = text;

    if (st.draft.type === "expense") {
      st.step = "group";
      await tryDeleteUserMessage(ctx);
      await showPrompt(ctx, st, kbGroups());
      return;
    }

    // ВЫРУЧКА - сохраняем
    await tryDeleteUserMessage(ctx);
    const r = await appendRow(st.draft);
    
    if (!r.ok) {
      await ctx.reply(`❌ ${randomError("networkError")}`);
      return;
    }

    await ctx.reply(`✅ ${st.draft.whom} внес ${formatNumber(st.draft.amount)} ₽ сегодня.`);
    st.draft = null;
    st.step = null;
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await showMainScreen(ctx, st);
    return;
  }

  if (st.step === "what") {
    if (text.length > 500) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLong"));
      return;
    }
    
    st.draft.what = text;
    await tryDeleteUserMessage(ctx);

    const r = await appendRow(st.draft);
    
    if (!r.ok) {
      await ctx.reply(`❌ ${randomError("networkError")}`);
      return;
    }

    await ctx.reply(`✅ Записано сегодня: ${formatNumber(st.draft.amount)} ₽.`);
    st.draft = null;
    st.step = null;
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await showMainScreen(ctx, st);
    return;
  }

  await tryDeleteUserMessage(ctx);
});

bot.launch();
console.log("Bot started");
