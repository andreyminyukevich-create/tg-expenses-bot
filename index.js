import "dotenv/config";
import { Telegraf, Markup } from "telegraf";

// ===== ENV =====
const BOT_TOKEN  = process.env.BOT_TOKEN;
const SCRIPT_URL = process.env.SCRIPT_URL;
const TOKEN      = process.env.TOKEN;
const TIMEZONE   = process.env.TIMEZONE || "Europe/Moscow";
const OWNER_ID   = process.env.OWNER_ID ? String(process.env.OWNER_ID).trim() : "";

if (!BOT_TOKEN)  throw new Error("BOT_TOKEN missing");
if (!SCRIPT_URL) throw new Error("SCRIPT_URL missing");
if (!TOKEN)      throw new Error("TOKEN missing");
if (!OWNER_ID)   throw new Error("OWNER_ID missing");
if (typeof fetch !== "function") throw new Error("Global fetch() not found. Use Node.js 18+.");

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

const sessions     = new Map();
const SESSION_TTL  = 30 * 60 * 1000;
const API_TIMEOUT  = 15_000;

const ERRORS = {
  invalidAmount: [
    "🤨 Это сумма или код от сейфа?",
    "😅 Я конечно умный, но это не похоже на деньги...",
    "🧐 Вы уверены, что это цифры? Попробуйте еще раз",
    "💸 Хм, что-то не то... Может, попробуем нормальную сумму?",
  ],
  tooLarge: [
    "😱 Воу-воу! Миллиард? Давайте что-то до миллиарда",
    "💰 Ого! А может всё-таки что-то поменьше?",
  ],
  tooLong: [
    "📚 Роман «Война и мир» короче! Макс 500 символов",
    "📖 Слишком много букв. Короче, пожалуйста!",
  ],
  networkError: [
    "🌐 Интернет куда-то пропал... Попробуйте еще раз",
    "📡 Связь потеряна. Повторите попытку",
    "🔌 Что-то с сетью... Попробуем еще раз?",
  ],
  timeout: [
    "⏱️ Таблица долго не отвечает. Попробуйте ещё раз",
    "🐌 GAS завис... Попробуйте через пару секунд",
  ],
};

function randomError(type) {
  const msgs = ERRORS[type] || ["Ошибка"];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

function cleanOldSessions() {
  const now = Date.now();
  for (const [id, st] of sessions.entries()) {
    if (now - (st.lastActivity || 0) > SESSION_TTL) sessions.delete(id);
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

function todayDDMMYYYY(dateObj = new Date()) {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIMEZONE,
    day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(dateObj);
  const dd   = parts.find(p => p.type === "day")?.value;
  const mm   = parts.find(p => p.type === "month")?.value;
  const yyyy = parts.find(p => p.type === "year")?.value;
  return `${dd}.${mm}.${yyyy}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayDDMMYYYY(d);
}

function formatMoneyRu(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0,00";
  const fixed = (Math.round(v * 100) / 100).toFixed(2);
  const [i, d] = fixed.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + (d || "00");
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ===== API =====
async function api(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const res = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, ...payload }),
      signal: controller.signal,
    });

    const text = await res.text();
    console.log(`[GAS] ${payload.action} → ${res.status}: ${text.slice(0, 200)}`);

    try { return JSON.parse(text); }
    catch { return { ok: false, error: `Non-JSON (${res.status}): ${text.slice(0, 200)}` }; }

  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`[GAS] TIMEOUT: ${payload.action}`);
      return { ok: false, error: "timeout" };
    }
    console.error(`[GAS] ERROR: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function apiError(r) {
  if (r.error === "timeout") return randomError("timeout");
  return randomError("networkError");
}

// ===== API CALLS =====
async function appendRow(d) {
  return api({ action: "append", type: d.type, date: d.date, amount: d.amount, whom: d.whom, group: d.group || "", what: d.what || "" });
}
async function deleteLastRow() {
  return api({ action: "delete_last" });
}
async function getStats(period) {
  return api({ action: "stats", period });
}
async function getGroupTotals(period) {
  return api({ action: "group_totals", period });
}
async function getTopPayers(period, limit) {
  return api({ action: "top_payers", period, limit: limit || 20 });
}
async function getTransactions(type, period) {
  return api({ action: "transactions", type, period });
}

// ===== AMOUNT PARSER =====
function parseAmountSmart(inputRaw) {
  let s = String(inputRaw ?? "").trim();
  s = s.replace(/[^\d.,\s''` + "`" + `-]/g, "").replace(/[\s''` + "`" + `]/g, "");

  if (!s || s.includes("-")) return { ok: false, reason: "invalid" };

  const hasDot   = s.includes(".");
  const hasComma = s.includes(",");

  const toNum = (str, dec) => {
    let x = str;
    if (dec === ",") {
      x = x.replace(/\./g, "");
      const last = x.lastIndexOf(",");
      if (last >= 0) x = x.slice(0, last).replace(/,/g, "") + "." + x.slice(last + 1);
    } else if (dec === ".") {
      x = x.replace(/,/g, "");
      const last = x.lastIndexOf(".");
      if (last >= 0) x = x.slice(0, last).replace(/\./g, "") + "." + x.slice(last + 1);
    } else {
      x = x.replace(/[.,]/g, "");
    }
    const v = Number(x);
    return Number.isFinite(v) ? round2(v) : NaN;
  };

  if (hasDot && hasComma) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const val = toNum(s, dec);
    return Number.isFinite(val) ? { ok: true, value: val } : { ok: false, reason: "invalid" };
  }

  const sep = hasDot ? "." : hasComma ? "," : null;

  if (!sep) {
    const val = toNum(s, null);
    return Number.isFinite(val) ? { ok: true, value: val } : { ok: false, reason: "invalid" };
  }

  const parts = s.split(sep);

  if (parts.length > 2) {
    const dec = parts[parts.length - 1].length <= 2 ? sep : null;
    const val = toNum(s, dec);
    return Number.isFinite(val) ? { ok: true, value: val } : { ok: false, reason: "invalid" };
  }

  const right = parts[1] || "";

  if (!parts[0] || !right) {
    const val = toNum(s, sep);
    return Number.isFinite(val) ? { ok: true, value: val } : { ok: false, reason: "invalid" };
  }

  if (right.length <= 2) {
    const val = toNum(s, sep);
    return Number.isFinite(val) ? { ok: true, value: val } : { ok: false, reason: "invalid" };
  }

  if (right.length === 3) {
    const a = toNum(s, null);
    const b = toNum(s, sep);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "ambiguous", options: [a, b] };
  }

  const val = toNum(s, null);
  return Number.isFinite(val) ? { ok: true, value: val } : { ok: false, reason: "invalid" };
}

// ===== PROMPT TEXT =====
function promptText(step, d) {
  if (step === "type") return "Выберите тип транзакции:";
  if (step === "date") return "📅 Выберите дату:";

  if (step === "amount") {
    return d.type === "revenue"
      ? "💰 Какую сумму получили?\n\nПримеры: 1234,56 | 1 234,56 | 1234.56"
      : "💸 Какую сумму потратили?\n\nПримеры: 1234,56 | 1 234,56 | 1234.56";
  }

  if (step === "amount_confirm") return "🤔 Не уверен, что вы имели в виду.\nВыберите правильный вариант:";

  if (step === "whom") {
    const a = formatMoneyRu(d.amount);
    const dateLabel = d.date !== todayDDMMYYYY() ? ` (${d.date})` : "";
    return d.type === "revenue"
      ? `💰 Записываю: <b>${a} ₽</b>${dateLabel}\n\n👤 От кого получили?`
      : `💸 Записываю: <b>${a} ₽</b>${dateLabel}\n\n👤 Кому заплатили?`;
  }

  if (step === "group") return "📁 Выберите группу:";
  if (step === "what")  return "📋 За что?";

  if (step === "confirm") {
    const icon = d.type === "revenue" ? "💰" : "💸";
    const lines = [
      `${icon} <b>Подтвердите запись:</b>`,
      ``,
      `📅 Дата: <b>${htmlEscape(d.date)}</b>`,
      `💵 Сумма: <b>${formatMoneyRu(d.amount)} ₽</b>`,
      `👤 ${d.type === "revenue" ? "От кого" : "Кому"}: <b>${htmlEscape(d.whom)}</b>`,
    ];
    if (d.type === "expense") {
      if (d.group) lines.push(`📁 Группа: <b>${htmlEscape(d.group)}</b>`);
      if (d.what)  lines.push(`📋 За что: <b>${htmlEscape(d.what)}</b>`);
    }
    lines.push(`🏷 Тип: <b>${d.type === "revenue" ? "Выручка" : "Затраты"}</b>`);
    return lines.join("\n");
  }

  return "";
}

// ===== KEYBOARDS =====
function kbMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Внести транзакцию", "start")],
    [Markup.button.callback("↩️ Отменить последнюю", "undo_last")],
    [Markup.button.callback("📊 Аналитика", "an")],
  ]);
}

function kbType() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💸 Затраты", "t:expense"), Markup.button.callback("💰 Выручка", "t:revenue")],
    [Markup.button.callback("Отмена", "cancel")],
  ]);
}

function kbDate() {
  const t = todayDDMMYYYY();
  const y = daysAgo(1);
  const d = daysAgo(2);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Сегодня (${t})`, `d:${t}`)],
    [Markup.button.callback(`Вчера (${y})`,   `d:${y}`)],
    [Markup.button.callback(d,                `d:${d}`)],
    [Markup.button.callback("Отмена", "cancel")],
  ]);
}

function kbCancel() {
  return Markup.inlineKeyboard([[Markup.button.callback("Отмена", "cancel")]]);
}

function kbRetrySend() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Повторить", "retry_send")],
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
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${formatMoneyRu(options[0])} ₽`, "amt:0")],
    [Markup.button.callback(`${formatMoneyRu(options[1])} ₽`, "amt:1")],
    [Markup.button.callback("Отмена", "cancel")],
  ]);
}

function kbConfirm() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Записать", "confirm_send"), Markup.button.callback("❌ Отмена", "cancel")],
  ]);
}

function kbAnalyticsMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💸 Затраты",            "an:exp")],
    [Markup.button.callback("💰 Поступления",        "an:rev")],
    [Markup.button.callback("📁 Затраты по группам", "an:groups")],
    [Markup.button.callback("🏆 Оплаты",             "an:payers")],
    [Markup.button.callback("← Назад",               "back_to_main")],
  ]);
}

function kbPeriods(prefix) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Сегодня",       `${prefix}:today`)],
    [Markup.button.callback("В этом месяце", `${prefix}:month`)],
    [Markup.button.callback("В этом году",   `${prefix}:year`)],
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
    const rev  = monthStats.revenue || 0;
    const exp  = monthStats.expense || 0;
    const bal  = rev - exp;
    const sign = bal >= 0 ? "+" : "−";
    lines.push(`📅 <b>ИТОГИ ЗА ${(monthStats.monthName || "ТЕКУЩИЙ МЕСЯЦ").toUpperCase()}</b>`);
    lines.push(`💰 Выручка: ${formatMoneyRu(rev)} ₽`);
    lines.push(`💸 Затраты: ${formatMoneyRu(exp)} ₽`);
    lines.push(`━━━━━━━━━━━━━━━━━`);
    lines.push(`📈 Баланс: ${sign}${formatMoneyRu(Math.abs(bal))} ₽`);
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
    try { await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId); } catch {}
    st.screenId = null;
  }
  const msg = await ctx.reply(text, { parse_mode: "HTML", ...kbMain() });
  st.screenId = msg.message_id;
}

async function showAnalyticsMenu(ctx, st) {
  await safeEditMessage(ctx, st, "📊 <b>АНАЛИТИКА</b>\n\nВыберите раздел:", {
    parse_mode: "HTML", ...kbAnalyticsMain(),
  });
}

async function showPrompt(ctx, st, keyboard) {
  const text = promptText(st.step, st.draft);
  if (st.screenId) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId); } catch {}
  }
  const msg = await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
  st.screenId = msg.message_id;
}

async function safeEditMessage(ctx, st, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (err.description?.includes("message to edit not found") || err.description?.includes("message is not modified")) {
      if (st.screenId) { try { await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId); } catch {} }
      const sent = await ctx.reply(text, extra);
      st.screenId = sent.message_id;
    } else {
      throw err;
    }
  }
}

async function tryDeleteUserMessage(ctx) {
  try { await ctx.deleteMessage(); } catch {}
}

// ===== FINISH TRANSACTION =====
async function finishTransaction(ctx, st) {
  const r = await appendRow(st.draft);

  if (!r.ok) {
    await ctx.reply(`❌ ${apiError(r)}\n\nМожем попробовать ещё раз.`, kbRetrySend());
    return;
  }

  const saved = { ...st.draft };
  st.draft = null; st.step = null; st.tmp = {};

  if (st.screenId) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId); } catch {}
    st.screenId = null;
  }

  const icon = saved.type === "revenue" ? "💰" : "💸";
  await ctx.reply(
    `${icon} Записано: <b>${formatMoneyRu(saved.amount)} ₽</b> — ${htmlEscape(saved.whom)} (${htmlEscape(saved.date)})`,
    { parse_mode: "HTML" }
  );

  await showMainScreen(ctx, st);
}

// ===== ANALYTICS HELPERS =====
function periodLabel(period) {
  if (period === "today") return `сегодня (${todayDDMMYYYY()})`;
  if (period === "month") return "в этом месяце";
  if (period === "year")  return `в ${new Date().getFullYear()} году`;
  return period;
}

function renderTransactionsList(title, period, items, type) {
  const lines = [title, `Период: <b>${htmlEscape(periodLabel(period))}</b>`, ""];
  if (!items.length) { lines.push("Пусто"); return lines.join("\n"); }
  let total = 0;
  items.forEach((t, i) => {
    const amt = Number(t.amount) || 0;
    total += amt;
    const whom = htmlEscape(t.whom || "");
    const date = htmlEscape(t.date || "");
    if (type === "expense") {
      const extra = [htmlEscape(t.group || ""), htmlEscape(t.what || "")].filter(Boolean).join(" — ");
      lines.push(`${i + 1}. ${date} | ${whom} — <b>${formatMoneyRu(amt)} ₽</b>${extra ? ` — ${extra}` : ""}`);
    } else {
      lines.push(`${i + 1}. ${date} | ${whom} — <b>${formatMoneyRu(amt)} ₽</b>`);
    }
  });
  lines.push("", `Итого: <b>${formatMoneyRu(total)} ₽</b>`);
  return lines.join("\n");
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (!isOwner(ctx)) { await denyAccess(ctx); return; }
  return next();
});

bot.start(async (ctx) => {
  const st = ensureState(ctx);
  await showMainScreen(ctx, st);
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  const st   = ensureState(ctx);

  if (data === "back_to_main") {
    await ctx.answerCbQuery();
    st.draft = null; st.step = null; st.tmp = {};
    await showMainScreen(ctx, st);
    return;
  }

  if (data === "an") {
    await ctx.answerCbQuery();
    await showAnalyticsMenu(ctx, st);
    return;
  }

  if (data === "undo_last") {
    await ctx.answerCbQuery("⏳ Отменяю...");
    const r = await deleteLastRow();
    if (r.ok) {
      if (st.screenId) { try { await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId); } catch {} st.screenId = null; }
      const d = r.deleted;
      await ctx.reply(
        `✅ Удалена запись: <b>${formatMoneyRu(d.amount)} ₽</b> — ${htmlEscape(d.whom)} (${htmlEscape(d.date)})`,
        { parse_mode: "HTML" }
      );
      await showMainScreen(ctx, st);
    } else {
      await ctx.answerCbQuery(
        r.error === "no rows to delete" ? "Нет записей для удаления" : "Ошибка удаления",
        { show_alert: true }
      );
    }
    return;
  }

  if (data === "an:exp") {
    await ctx.answerCbQuery();
    await safeEditMessage(ctx, st, "💸 <b>ЗАТРАТЫ</b>\n\nВыберите период:", { parse_mode: "HTML", ...kbPeriods("an:exp") });
    return;
  }
  if (data === "an:rev") {
    await ctx.answerCbQuery();
    await safeEditMessage(ctx, st, "💰 <b>ПОСТУПЛЕНИЯ</b>\n\nВыберите период:", { parse_mode: "HTML", ...kbPeriods("an:rev") });
    return;
  }
  if (data === "an:groups") {
    await ctx.answerCbQuery();
    await safeEditMessage(ctx, st, "📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>\n\nВыберите период:", { parse_mode: "HTML", ...kbPeriods("an:groups") });
    return;
  }
  if (data === "an:payers") {
    await ctx.answerCbQuery();
    await safeEditMessage(ctx, st, "🏆 <b>ОПЛАТЫ</b>\n\nВыберите период:", { parse_mode: "HTML", ...kbPeriods("an:payers") });
    return;
  }

  if (data.startsWith("an:exp:") || data.startsWith("an:rev:")) {
    const parts  = data.split(":");
    const kind   = parts[1];
    const period = parts[2];
    await ctx.answerCbQuery("⏳ Загружаю...");
    const type = kind === "exp" ? "expense" : "revenue";
    const tr   = await getTransactions(type, period);
    if (!tr.ok) { await safeEditMessage(ctx, st, `❌ ${apiError(tr)}`, { parse_mode: "HTML", ...kbBackToAnalytics() }); return; }
    const items = Array.isArray(tr.transactions) ? tr.transactions : [];
    const title = kind === "exp" ? "💸 <b>ЗАТРАТЫ</b>" : "💰 <b>ПОСТУПЛЕНИЯ</b>";
    await safeEditMessage(ctx, st, renderTransactionsList(title, period, items, type), { parse_mode: "HTML", ...kbBackToAnalytics() });
    return;
  }

  if (data.startsWith("an:groups:")) {
    const period = data.split(":")[2];
    await ctx.answerCbQuery("⏳ Загружаю...");
    const r = await getGroupTotals(period);
    if (!r.ok) { await safeEditMessage(ctx, st, `❌ ${apiError(r)}`, { parse_mode: "HTML", ...kbBackToAnalytics() }); return; }
    const items = Array.isArray(r.items) ? r.items : [];
    if (!items.length) {
      await safeEditMessage(ctx, st, `📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>\n\nПериод: <b>${htmlEscape(periodLabel(period))}</b>\n\nПусто`, { parse_mode: "HTML", ...kbBackToAnalytics() });
      return;
    }
    let total = 0;
    const lines = [`📁 <b>ЗАТРАТЫ ПО ГРУППАМ</b>`, `Период: <b>${htmlEscape(periodLabel(period))}</b>`, ""];
    items.forEach((it, i) => { total += Number(it.amount) || 0; lines.push(`${i + 1}. ${htmlEscape(it.group)} — <b>${formatMoneyRu(it.amount)} ₽</b>`); });
    lines.push("", `Итого: <b>${formatMoneyRu(total)} ₽</b>`);
    await safeEditMessage(ctx, st, lines.join("\n"), { parse_mode: "HTML", ...kbBackToAnalytics() });
    return;
  }

  if (data.startsWith("an:payers:")) {
    const period = data.split(":")[2];
    await ctx.answerCbQuery("⏳ Загружаю...");
    const r = await getTopPayers(period, 50);
    if (!r.ok) { await safeEditMessage(ctx, st, `❌ ${apiError(r)}`, { parse_mode: "HTML", ...kbBackToAnalytics() }); return; }
    const payers = Array.isArray(r.payers) ? r.payers : [];
    if (!payers.length) {
      await safeEditMessage(ctx, st, `🏆 <b>ОПЛАТЫ</b>\n\nПериод: <b>${htmlEscape(periodLabel(period))}</b>\n\nПусто`, { parse_mode: "HTML", ...kbBackToAnalytics() });
      return;
    }
    let total = 0;
    const lines = [`🏆 <b>ОПЛАТЫ</b>`, `Период: <b>${htmlEscape(periodLabel(period))}</b>`, ""];
    payers.forEach((p, i) => { total += Number(p.total) || 0; lines.push(`${i + 1}. ${htmlEscape(p.name)} — <b>${formatMoneyRu(p.total)} ₽</b>${p.count > 1 ? ` (${p.count})` : ""}`); });
    lines.push("", `Итого: <b>${formatMoneyRu(total)} ₽</b>`);
    await safeEditMessage(ctx, st, lines.join("\n"), { parse_mode: "HTML", ...kbBackToAnalytics() });
    return;
  }

  if (data === "start") {
    st.draft = { date: todayDDMMYYYY() };
    st.step  = "type";
    st.tmp   = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbType());
    return;
  }

  if (data === "cancel") {
    st.draft = null; st.step = null; st.tmp = {};
    await ctx.answerCbQuery("Отменено");
    await showMainScreen(ctx, st);
    return;
  }

  if (data === "t:expense" || data === "t:revenue") {
    st.draft = st.draft || {};
    st.draft.type = data.split(":")[1];
    st.draft.date = todayDDMMYYYY();
    st.step = "date";
    st.tmp  = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbDate());
    return;
  }

  if (data.startsWith("d:")) {
    if (!st.draft) { await ctx.answerCbQuery("Неактуально"); return; }
    st.draft.date = data.slice(2);
    st.step = "amount";
    st.tmp  = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (data.startsWith("amt:")) {
    if (st.step !== "amount_confirm" || !st.tmp?.amountOptions) { await ctx.answerCbQuery("Неактуально"); return; }
    const choice = Number(data.split(":")[1]);
    const opts   = st.tmp.amountOptions;
    if (!Number.isInteger(choice) || choice < 0 || choice >= opts.length) { await ctx.answerCbQuery("Ошибка"); return; }
    st.draft.amount = opts[choice];
    st.step = "whom";
    st.tmp  = {};
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (data.startsWith("g:")) {
    if (!st.draft || st.draft.type !== "expense") { await ctx.answerCbQuery("Неактуально"); return; }
    const idx = Number(data.slice(2));
    if (!Number.isInteger(idx) || idx < 0 || idx >= GROUPS.length) { await ctx.answerCbQuery("Ошибка"); return; }
    st.draft.group = GROUPS[idx];
    st.step = "what";
    await ctx.answerCbQuery();
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (data === "confirm_send") {
    if (!st.draft) { await ctx.answerCbQuery("Нечего отправлять"); return; }
    await ctx.answerCbQuery("⏳ Записываю...");
    if (st.screenId) { try { await ctx.telegram.deleteMessage(ctx.chat.id, st.screenId); } catch {} st.screenId = null; }
    await finishTransaction(ctx, st);
    return;
  }

  if (data === "retry_send") {
    if (!st.draft) { await ctx.answerCbQuery("Нечего отправлять"); return; }
    await ctx.answerCbQuery("⏳ Пытаюсь отправить...");
    await finishTransaction(ctx, st);
    return;
  }

  await ctx.answerCbQuery();
});

bot.on("text", async (ctx) => {
  const st   = ensureState(ctx);
  const text = (ctx.message?.text || "").trim();

  if (!st.draft || !st.step) { await tryDeleteUserMessage(ctx); return; }

  if (st.step === "date") {
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
      await tryDeleteUserMessage(ctx);
      await ctx.reply("📅 Введите дату в формате ДД.ММ.ГГГГ, например: 15.02.2026");
      return;
    }
    st.draft.date = text;
    st.step = "amount";
    st.tmp  = {};
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (st.step === "amount") {
    const parsed = parseAmountSmart(text);
    if (!parsed.ok && parsed.reason === "ambiguous") {
      await tryDeleteUserMessage(ctx);
      st.step = "amount_confirm";
      st.tmp  = { amountOptions: parsed.options };
      await showPrompt(ctx, st, kbAmountAmbiguous(parsed.options));
      return;
    }
    if (!parsed.ok) { await tryDeleteUserMessage(ctx); await ctx.reply(randomError("invalidAmount")); return; }
    if (parsed.value <= 0 || parsed.value > 999999999.99) { await tryDeleteUserMessage(ctx); await ctx.reply(randomError("tooLarge")); return; }
    st.draft.amount = round2(parsed.value);
    st.step = "whom";
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  if (st.step === "whom") {
    if (text.length > 500) { await tryDeleteUserMessage(ctx); await ctx.reply(randomError("tooLong")); return; }
    st.draft.whom = text;
    if (st.draft.type === "expense") {
      st.step = "group";
      await tryDeleteUserMessage(ctx);
      await showPrompt(ctx, st, kbGroups());
      return;
    }
    st.step = "confirm";
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbConfirm());
    return;
  }

  if (st.step === "what") {
    if (text.length > 500) { await tryDeleteUserMessage(ctx); await ctx.reply(randomError("tooLong")); return; }
    st.draft.what = text;
    st.step = "confirm";
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbConfirm());
    return;
  }

  if (st.step === "amount_confirm") {
    st.step = "amount";
    st.tmp  = {};
    await tryDeleteUserMessage(ctx);
    await showPrompt(ctx, st, kbCancel());
    return;
  }

  await tryDeleteUserMessage(ctx);
});

// ===== LAUNCH =====
async function startBot(retries = 5) {
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log("Bot started");
  } catch (err) {
    if (err.response?.error_code === 409 && retries > 0) {
      console.log(`[409] Conflict, retry in 5s... (${retries} left)`);
      await new Promise(r => setTimeout(r, 5000));
      return startBot(retries - 1);
    }
    throw err;
  }
}

startBot();

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
