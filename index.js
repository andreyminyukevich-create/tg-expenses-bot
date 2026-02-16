import "dotenv/config";
import { Telegraf, Markup } from "telegraf";

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const SCRIPT_URL = process.env.SCRIPT_URL;
const TOKEN = process.env.TOKEN;
const TIMEZONE = process.env.TIMEZONE || "Europe/Amsterdam";
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID).trim() : "";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!SCRIPT_URL) throw new Error("SCRIPT_URL missing");
if (!TOKEN) throw new Error("TOKEN missing");
if (!OWNER_ID) throw new Error("OWNER_ID missing (set your Telegram user id in env)");
if (typeof fetch !== "function") {
  throw new Error("Global fetch() not found. Use Node.js 18+ or add a fetch polyfill.");
}

// ===== CONSTS =====
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
  const msgs = ERRORS[type] || ["Ошибка"];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

function cleanOldSessions() {
  const now = Date.now();
  for (const [userId, st] of sessions.entries()) {
    if (now - (st.lastActivity || 0) > SESSION_TTL) sessions.delete(userId);
  }
}
setInterval(cleanOldSessions, 10 * 60 * 1000);

// ===== HELPERS =====
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

  const dd = parts.find((p) => p.type === "day")?.value;
  const mm = parts.find((p) => p.type === "month")?.value;
  const yyyy = parts.find((p) => p.type === "year")?.value;
  return `${dd}.${mm}.${yyyy}`;
}

// формат "* *,**" => 1 234,56
function formatMoneyRu(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0,00";
  const fixed = (Math.round(v * 100) / 100).toFixed(2);
  const [i, d] = fixed.split(".");
  const intPart = i.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${intPart},${d || "00"}`;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Безопасное редактирование сообщения (если не получается - отправляет новое)
async function safeEditMessage(ctx, st, text, extra = {}) {
  try {
    // Пытаемся отредактировать через ctx (он знает message_id из callback_query)
    await ctx.editMessageText(text, extra);
  } catch (error) {
    // Если сообщение удалено или не найдено - отправляем новое
    if (error.description?.includes("message to edit not found") || 
        error.description?.includes("message is not modified")) {
      const sent = await ctx.reply(text, extra);
      st.screenId = sent.message_id;
    } else {
      throw error; // другие ошибки пробрасываем дальше
    }
  }
}

// Умный парсер суммы.
// { ok:true, value:number } или { ok:false, reason:"invalid"|"ambiguous", options?:number[] }
function parseAmountSmart(inputRaw) {
  let s = String(inputRaw ?? "").trim();

  // убираем валюты/буквы, оставляем цифры/разделители/минус
  s = s.replace(/[^\d.,\s'’`-]/g, "");
  s = s.replace(/[\s'’`]/g, ""); // пробелы/апострофы как разделители тысяч

  if (!s) return { ok: false, reason: "invalid" };
  if (s.includes("-")) return { ok: false, reason: "invalid" };

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  const toNum = (str, decimalSep) => {
    let x = str;
    if (decimalSep === ",") {
      x = x.replace(/\./g, "");
      const last = x.lastIndexOf(",");
      if (last >= 0) x = x.slice(0, last).replace(/,/g, "") + "." + x.slice(last + 1);
    } else if (decimalSep === ".") {
      x = x.replace(/,/g, "");
      const last = x.lastIndexOf(".");
      if (last >= 0) x = x.slice(0, last).replace(/\./g, "") + "." + x.slice(last + 1);
    } else {
      x = x.replace(/[.,]/g, "");
    }
    const v = Number(x);
    if (!Number.isFinite(v)) return NaN;
    return round2(v);
  };

  // есть и точка и запятая: десятичный — последний из них
  if (hasDot && hasComma) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const val = toNum(s, dec);
    if (!Number.isFinite(val)) return { ok: false, reason: "invalid" };
    return { ok: true, value: val };
  }

  const sep = hasDot ? "." : hasComma ? "," : null;

  if (!sep) {
    const val = toNum(s, null);
    if (!Number.isFinite(val)) return { ok: false, reason: "invalid" };
    return { ok: true, value: val };
  }

  const parts = s.split(sep);

  if (parts.length > 2) {
    const lastLen = parts[parts.length - 1].length;
    const dec = lastLen <= 2 ? sep : null;
    const val = toNum(s, dec);
    if (!Number.isFinite(val)) return { ok: false, reason: "invalid" };
    return { ok: true, value: val };
  }

  const left = parts[0] || "";
  const right = parts[1] || "";

  if (!left || !right) {
    const val = toNum(s, sep);
    if (!Number.isFinite(val)) return { ok: false, reason: "invalid" };
    return { ok: true, value: val };
  }

  if (right.length <= 2) {
    const val = toNum(s, sep);
    if (!Number.isFinite(val)) return { ok: false, reason: "invalid" };
    return { ok: true, value: val };
  }

  if (right.length === 3) {
    const asThousands = toNum(s, null); // 1234
    const asDecimal = toNum(s, sep); // 1.234
    if (!Number.isFinite(asThousands) || !Number.isFinite(asDecimal)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: false, reason: "ambiguous", options: [asThousands, asDecimal] };
  }

  const val = toNum(s, null);
  if (!Number.isFinite(val)) return { ok: false, reason: "invalid" };
  return { ok: true, value: val };
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

// ===== API CALLS =====
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
  return await api({ action: "stats", period });
}

async function getGroupTotals(period) {
  return await api({ action: "group_totals", period });
}

async function getTopPayers(period, limit) {
  return await api({ action: "top_payers", period, limit: limit || 20 });
}

// НОВОЕ: полный список транзакций по типу за период (today/month/year)
async function getTransactions(type, period) {
  return await api({ action: "transactions", type, period });
}

// ===== UI TEXT =====
function promptText(step, d) {
  if (step === "type") return "Выберите тип транзакции:";

  if (step === "amount") {
    return d.type === "revenue"
      ? "💰 Какую сумму вы получили?\n\nПримеры: 1234,56 | 1 234,56 | 1.234,56 | 1234.56"
      : "💸 Какую сумму вы потратили?\n\nПримеры: 1234,56 | 1 234,56 | 1.234,56 | 1234.56";
  }

  if (step === "amount_confirm") {
    return "🤔 Я не уверен, что вы имели в виду.\nВыберите правильный вариант суммы:";
  }

  if (step === "whom") {
    const a = formatMoneyRu(d.amount);
    return d.type === "revenue" ? `👤 От кого получили ${a} ₽?` : `👤 Кому заплатили ${a} ₽?`;
  }

  if (step === "group") return "📁 Выберите группу:";
  if (step === "what") return "📋 За что?";

  return "";
}

// ===== KEYBOARDS =====
function kbMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Внести транзакцию", "start")],
    [Markup.button.callback("📊 Аналитика", "an")],
  ]);
}

function kbType() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Затраты", "t:expense"), Markup.button.callback("Выручка", "t:revenue")],
    [Markup.button.callback("Отмена", "cancel")],
  ]);
}

function kbCancel() {
  return Markup.inlineKeyboard([[Markup.button.callback("Отмена", "cancel")]]);
}

function kbRetrySend() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Повторить отправку", "retry_send")],
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

function kbAmountAmbiguous(options) {
  const a = formatMoneyRu(options[0]);
  const b = formatMoneyRu(options[1]);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${a} ₽`, `amt:0`)],
    [Markup.button.callback(`${b} ₽`, `amt:1`)],
    [Markup.button.callback("Отмена", "cancel")],
  ]);
}

// === Аналитика ===
function kbAnalyticsMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💸 Затраты", "an:exp")],
    [Markup.button.callback("💰 Поступления", "an:rev")],
    [Markup.button.callback("📁 Затраты по группам", "an:groups")],
    [Markup.button.callback("🏆 Оплаты", "an:payers")],
    [Markup.button.callback("← Назад", "back_to_main")],
  ]);
}

function kbPeriods(prefix) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Сегодня", `${prefix}:today`)],
    [Markup.button.callback("В этом месяце", `${prefix}:month`)],
    [Markup.button.callback("В этом году", `${prefix}:year`)],
    [Markup.button.callback("← Назад", "an")],
  ]);
}

function kbBackToAnalytics() {
  return Markup.inlineKeyboard([[Markup.button.callback("← Назад", "an")]]);
}

// ===== SESSION =====
function ensureState(ctx) {
  const userId = String(ctx.from?.id || "");
  let st = sessions.get(userId);

  if (!st) {
    st = { screenId: null, draft: null, step: null, lastActivity: Date.now(), tmp: {} };
    sessions.set(userId, st);
  }

  st.lastActivity = Date.now();
  return st;
}

function isOwner(ctx) {
  return String(ctx.from?.id || "") === OWNER_ID;
}

async function denyAccess(ctx) {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery("⛔️ Нет доступа", { show_alert: true });
    else await ctx.reply("⛔️ Нет доступа");
  } catch {}
}

// ===== RENDER =====
async function renderMainScreen() {
  const [monthStats, topYear] = await Promise.all([getStats("month"), getTopPayers("year", 3)]);
  const lines = [];

  if (monthStats.ok) {
    const mRevenue = monthStats.revenue || 0;
    const mExpense = monthStats.expense || 0;
    const mBalance = mRevenue - mExpense;
    const sign = mBalance >= 0 ? "+" : "−";

    lines.push(`📅 <b>ИТОГИ ЗА ${(monthStats.monthName || "ТЕКУЩИЙ МЕСЯЦ").toUpperCase()}</b>`);
    lines.push(`💰 Выручка: ${formatMoneyRu(mRevenue)} ₽`);
    lines.push(`💸 Затраты: ${formatMoneyRu(mExpense)} ₽`);
    lines.push(`━━━━━━━━━━━━━━━━━`);
    lines.push(`📈 Баланс: ${sign}${formatMoneyRu(Math.abs(mBalance))} ₽`);
  } else {
    lines.push("⚠️ Не получилось загрузить итоги месяца");
  }

  lines.push("");
  lines.push("🏆 <b>Топ-3 плательщика за год</b>");
  if (topYear.ok && Array.isArray(topYear.payers) && topYear.payers.length) {
    topYear.payers.slice(0, 3).forEach((p, i) => {
      lines.push(`${i + 1}. ${htmlEscape(p.name)} — ${formatMoneyRu(p.total)} ₽`);
    });
  } else {
    lines.push("Пока пусто");
  }

  return lines.join("\n");
}

async function showMainScreen(ctx, st) {
  const text = await renderMainScreen();

  if (st.screenId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId);
    } catch {}
    st.screenId = null;
  }

  const msg = await ctx.reply(text, { parse_mode: "HTML", ...kbMain() });
  st.screenId = msg.message_id;
}

async function showAnalyticsMenu(ctx, st) {
  const text = "📊 <b>АНАЛИТИКА</b>\n\nВыберите раздел:";
  await safeEditMessage(ctx, st, text, {
    parse_mode: "HTML",
    ...kbAnalyticsMain(),
  });
}

async function showPrompt(ctx, st, keyboard) {
  const text = promptText(st.step, st.draft);
  await safeEditMessage(ctx, st, text, {
    parse_mode: "HTML",
    ...keyboard,
  });
}

async function tryDeleteUserMessage(ctx) {
  try {
    await ctx.deleteMessage();
  } catch {}
}

// ===== REPORT RENDERERS =====
function periodLabel(period, meta) {
  if (period === "today") return `сегодня (${meta?.date || todayDDMMYYYY()})`;
  if (period === "month") return meta?.monthName ? `в ${String(meta.monthName).toUpperCase()}` : "в этом месяце";
  if (period === "year") return meta?.year ? `в ${meta.year} году` : "в этом году";
  return period;
}

function renderTransactionsList(title, period, meta, items, type) {
  // type: "expense" | "revenue"
  const lines = [];
  lines.push(`${title}`);
  lines.push(`Период: <b>${htmlEscape(periodLabel(period, meta))}</b>`);
  lines.push("");

  if (!items.length) {
    lines.push("Пусто");
    return lines.join("\n");
  }

  let total = 0;

  items.forEach((t, i) => {
    const amt = Number(t.amount) || 0;
    total += amt;

    const date = htmlEscape(t.date || "");
    const whom = htmlEscape(t.whom || "");
    const group = htmlEscape(t.group || "");
    const what = htmlEscape(t.what || "");

    if (type === "expense") {
      const extra = [group, what].filter(Boolean).join(" — ");
      lines.push(`${i + 1}. ${date} | ${whom} — <b>${formatMoneyRu(amt)} ₽</b>${extra ? ` — ${extra}` : ""}`);
    } else {
      // revenue
      lines.push(`${i + 1}. ${date} | ${whom} — <b>${formatMoneyRu(amt)} ₽</b>`);
    }
  });

  lines.push("");
  lines.push(`Итого: <b>${formatMoneyRu(total)} ₽</b>`);

  return lines.join("\n");
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (!isOwner(ctx)) {
    await denyAccess(ctx);
    return;
  }
  return next();
});

bot.start(async (ctx) => {
  const st = ensureState(ctx);
  await showMainScreen(ctx, st);
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  const st = ensureState(ctx);

  if (data === "back_to_main") {
    await ctx.answerCbQuery();
    st.draft = null;
    st.step = null;
    st.tmp = {};
    await showMainScreen(ctx, st);
    return;
  }

  if (data === "an") {
    await ctx.answerCbQuery();
    await showAnalyticsMenu(ctx, st);
    return;
  }

  if (data === "an:exp") {
    await ctx.answerCbQuery();
    const text = "💸 <b>ЗАТРАТЫ</b>\n\nВыберите период:";
    await safeEditMessage(ctx, st, text, {
      parse_mode: "HTML",
      ...kbPeriods("an:exp"),
    });
    return;
  }

  if (data === "an:rev") {
    await ctx.answerCbQuery();
    const text = "💰 <b>ПОСТУПЛЕНИЯ</b>\n\nВыберите период:";
    await safeEditMessage(ctx, st, text, {
      parse_mode: "HTML",
      ...kbPeriods("an:rev"),
    });
    return;
  }

  if (data === "an:groups") {
    await ctx.answerCbQuery();
    const text = "📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>\n\nВыберите период:";
    await safeEditMessage(ctx, st, text, {
      parse_mode: "HTML",
      ...kbPeriods("an:groups"),
    });
    return;
  }

  if (data === "an:payers") {
    await ctx.answerCbQuery();
    const text = "🏆 <b>ОПЛАТЫ</b>\n\nВыберите период:";
    await safeEditMessage(ctx, st, text, {
      parse_mode: "HTML",
      ...kbPeriods("an:payers"),
    });
    return;
  }

  // ===== АНАЛИТИКА: ЗАТРАТЫ/ПОСТУПЛЕНИЯ (ПОЛНЫЙ СПИСОК) =====
  if (data.startsWith("an:exp:") || data.startsWith("an:rev:")) {
    const [_, kind, period] = data.split(":"); // an, exp|rev, today|month|year
    await ctx.answerCbQuery("⏳ Загружаю...");

    const type = kind === "exp" ? "expense" : "revenue";
    const tr = await getTransactions(type, period);

    if (!tr.ok) {
      await safeEditMessage(ctx, st, `❌ ${randomError("networkError")}`, {
        parse_mode: "HTML",
        ...kbBackToAnalytics(),
      });
      return;
    }

    // meta для подписи периода
    const meta = {};
    if (period === "today") meta.date = todayDDMMYYYY();
    if (period === "month") {
      // попробуем аккуратно получить monthName через stats, чтобы красиво подписать
      const s = await getStats("month");
      if (s?.ok) meta.monthName = s.monthName;
    }
    if (period === "year") meta.year = new Date().getFullYear();

    const items = Array.isArray(tr.transactions) ? tr.transactions : [];

    const title = kind === "exp" ? "💸 <b>ЗАТРАТЫ</b>" : "💰 <b>ПОСТУПЛЕНИЯ</b>";
    const text = renderTransactionsList(title, period, meta, items, type);

    await safeEditMessage(ctx, st, text, {
      parse_mode: "HTML",
      ...kbBackToAnalytics(),
    });
    return;
  }

  // ===== АНАЛИТИКА: ЗАТРАТЫ ПО ГРУППАМ (СПИСОК СУММ) =====
  if (data.startsWith("an:groups:")) {
    const period = data.split(":")[2];
    await ctx.answerCbQuery("⏳ Загружаю...");

    const r = await getGroupTotals(period);

    if (!r.ok) {
      await safeEditMessage(ctx, st, `❌ ${randomError("networkError")}`, {
        parse_mode: "HTML",
        ...kbBackToAnalytics(),
      });
      return;
    }

    const periodText =
      period === "today" ? `сегодня (${todayDDMMYYYY()})` : period === "month" ? "в этом месяце" : "в этом году";

    const items = Array.isArray(r.items) ? r.items : [];
    if (!items.length) {
      await safeEditMessage(
        ctx,
        st,
        `📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>\n\nПериод: <b>${htmlEscape(periodText)}</b>\n\nПусто`,
        { parse_mode: "HTML", ...kbBackToAnalytics() }
      );
      return;
    }

    const lines = [];
    lines.push(`📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>`);
    lines.push(`Период: <b>${htmlEscape(periodText)}</b>`);
    lines.push("");

    let total = 0;
    items.forEach((it, i) => {
      total += Number(it.amount) || 0;
      lines.push(`${i + 1}. ${htmlEscape(it.group)} — <b>${formatMoneyRu(it.amount)} ₽</b>`);
    });

    lines.push("");
    lines.push(`Итого: <b>${formatMoneyRu(total)} ₽</b>`);

    await safeEditMessage(ctx, st, lines.join("\n"), {
      parse_mode: "HTML",
      ...kbBackToAnalytics(),
    });
    return;
  }

  // ===== АНАЛИТИКА: ОПЛАТЫ (ПЛАТЕЛЬЩИКИ) =====
  if (data.startsWith("an:payers:")) {
    const period = data.split(":")[2];
    await ctx.answerCbQuery("⏳ Загружаю...");

    const r = await getTopPayers(period, 50);

    if (!r.ok) {
      await safeEditMessage(ctx, st, `❌ ${randomError("networkError")}`, {
        parse_mode: "HTML",
        ...kbBackToAnalytics(),
      });
      return;
    }

    const periodText =
      period === "today" ? `сегодня (${todayDDMMYYYY()})` : period === "month" ? "в этом месяце" : "в этом году";

    const payers = Array.isArray(r.payers) ? r.payers : [];
    if (!payers.length) {
      await safeEditMessage(
        ctx,
        st,
        `🏆 <b>ОПЛАТЫ</b>\n\nПериод: <b>${htmlEscape(periodText)}</b>\n\nПусто`,
        { parse_mode: "HTML", ...kbBackToAnalytics() }
      );
      return;
    }

    const lines = [];
    lines.push(`🏆 <b>ОПЛАТЫ</b>`);
    lines.push(`Период: <b>${htmlEscape(periodText)}</b>`);
    lines.push("");

    let total = 0;
    payers.forEach((p, i) => {
      total += Number(p.total) || 0;
      const cnt = p.count > 1 ? ` (${p.count})` : "";
      lines.push(`${i + 1}. ${htmlEscape(p.name)} — <b>${formatMoneyRu(p.total)} ₽</b>${cnt}`);
    });

    lines.push("");
    lines.push(`Итого: <b>${formatMoneyRu(total)} ₽</b>`);

    await safeEditMessage(ctx, st, lines.join("\n"), {
      parse_mode: "HTML",
      ...kbBackToAnalytics(),
    });
    return;
  }

  // ===== TRANSACTIONS FLOW =====
  if (data === "start") {
    st.draft = { date: todayDDMMYYYY() };
    st.step = "type";
    st.tmp = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbType());
    return;
  }

  if (data === "cancel") {
    st.draft = null;
    st.step = null;
    st.tmp = {};
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
    st.tmp = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (data.startsWith("amt:")) {
    if (st.step !== "amount_confirm" || !st.tmp?.amountOptions) {
      await ctx.answerCbQuery("Неактуально");
      return;
    }

    const choice = Number(data.split(":")[1]);
    const opts = st.tmp.amountOptions;

    if (!Number.isInteger(choice) || choice < 0 || choice >= opts.length) {
      await ctx.answerCbQuery("Ошибка");
      return;
    }

    st.draft.amount = opts[choice];
    st.step = "whom";
    st.tmp = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (data === "retry_send") {
    if (!st.draft) {
      await ctx.answerCbQuery("Нечего отправлять");
      return;
    }
    await ctx.answerCbQuery("⏳ Пытаюсь отправить...");

    const r = await appendRow(st.draft);

    if (!r.ok) {
      await safeEditMessage(
        ctx,
        st,
        `❌ ${randomError("networkError")}\n\nМожем попробовать ещё раз.`,
        { parse_mode: "HTML", ...kbRetrySend() }
      );
      return;
    }

    st.draft = null;
    st.step = null;
    st.tmp = {};
    await showMainScreen(ctx, st);
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
  const text = (ctx.message?.text || "").trim();

  if (!st.draft || !st.step) {
    await tryDeleteUserMessage(ctx);
    return;
  }

  if (st.step === "amount") {
    const parsed = parseAmountSmart(text);

    if (!parsed.ok && parsed.reason === "ambiguous") {
      await tryDeleteUserMessage(ctx);
      st.step = "amount_confirm";
      st.tmp = { amountOptions: parsed.options };
      await showPrompt(ctx, st, kbAmountAmbiguous(parsed.options));
      return;
    }

    if (!parsed.ok) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("invalidAmount"));
      return;
    }

    const val = parsed.value;

    if (val <= 0 || val > 999999999.99) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply(randomError("tooLarge"));
      return;
    }

    st.draft.amount = round2(val);
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

    await tryDeleteUserMessage(ctx);
    const r = await appendRow(st.draft);

    if (!r.ok) {
      await ctx.reply(`❌ ${randomError("networkError")}`, kbRetrySend());
      return;
    }

    await ctx.reply(`✅ ${htmlEscape(st.draft.whom)} внёс ${formatMoneyRu(st.draft.amount)} ₽ сегодня.`, {
      parse_mode: "HTML",
    });

    st.draft = null;
    st.step = null;
    st.tmp = {};

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
      await ctx.reply(`❌ ${randomError("networkError")}`, kbRetrySend());
      return;
    }

    await ctx.reply(`✅ Записано: ${formatMoneyRu(st.draft.amount)} ₽ сегодня.`);

    st.draft = null;
    st.step = null;
    st.tmp = {};

    await showMainScreen(ctx, st);
    return;
  }

  if (st.step === "amount_confirm") {
    st.step = "amount";
    st.tmp = {};
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  await tryDeleteUserMessage(ctx);
});

bot.launch();
console.log("Bot started");

// Graceful shutdown для Railway
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
