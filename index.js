import "dotenv/config";
import http from "http";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SCRIPT_URL = process.env.SCRIPT_URL;
const TOKEN = process.env.TOKEN;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!SCRIPT_URL) throw new Error("SCRIPT_URL missing");
if (!TOKEN) throw new Error("TOKEN missing");

// Render Web Service: держим порт открытым
const port = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(port, () => console.log("HTTP server listening on", port));

const GROUPS = [
  "поставщик",
  "зп",
  "возврат Илье",
  "инструм для раб",
  "командировки",
  "склад",
  "налоги",
  "доставка",
  "разведка",
  "подарки клиентам",
  "бензин и то",
  "транс комп",
  "сайт",
  "ИИ",
];

const sessions = new Map(); // userId -> draft

function todayDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function mainKeyboard() {
  return Markup.keyboard([["Внести транзакцию"]]).resize();
}

function typeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Затраты", "t:expense"), Markup.button.callback("Выручка", "t:revenue")],
  ]);
}

function groupsKeyboard() {
  const rows = [];
  for (let i = 0; i < GROUPS.length; i += 2) {
    const a = GROUPS[i];
    const b = GROUPS[i + 1];
    const row = [Markup.button.callback(a, `g:${a}`)];
    if (b) row.push(Markup.button.callback(b, `g:${b}`));
    rows.push(row);
  }
  rows.push([Markup.button.callback("Отмена", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

async function sendToSheet(exp) {
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: TOKEN,
      type: exp.type,     // expense | revenue
      date: exp.date,
      amount: exp.amount,
      whom: exp.whom,
      group: exp.group,
      what: exp.what,
    }),
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` };
  }
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("Готово.", mainKeyboard());
});

bot.command("cancel", (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply("Отменено.", mainKeyboard());
});

bot.hears("Внести транзакцию", async (ctx) => {
  sessions.set(ctx.from.id, { step: "type", date: todayDDMMYYYY() });
  await ctx.reply("Тип транзакции:", typeKeyboard());
});

bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const text = ctx.message.text.trim();

  if (s.step === "date") {
    // принимаем dd.mm.yyyy или dd.mm (тогда год текущий)
    const m = text.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
    if (!m) return ctx.reply("Дата в формате ДД.ММ или ДД.ММ.ГГГГ");

    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    let yyyy = m[3];
    if (!yyyy) yyyy = String(new Date().getFullYear());
    else if (yyyy.length === 2) yyyy = "20" + yyyy;

    s.date = `${dd}.${mm}.${yyyy}`;
    s.step = "amount";
    return ctx.reply("Сумма?");
  }

  if (s.step === "amount") {
    const val = Number(text.replace(",", "."));
    if (!Number.isFinite(val)) return ctx.reply("Нужно число.");
    s.amount = val;
    s.step = "whom";
    return ctx.reply(s.type === "expense" ? "Кому?" : "Кто?");
  }

  if (s.step === "whom") {
    s.whom = text;

    if (s.type === "expense") {
      s.step = "group";
      return ctx.reply("Группа:", groupsKeyboard());
    } else {
      s.step = "save_revenue";
      // для выручки больше ничего не спрашиваем, сохраняем
      try {
        const r = await sendToSheet(s);
        if (!r.ok) throw new Error(r.error || "unknown error");
        await ctx.reply("Записано.", mainKeyboard());
      } catch (e) {
        await ctx.reply(`Ошибка: ${e?.message || e}`, mainKeyboard());
      }
      sessions.delete(ctx.from.id);
      return;
    }
  }

  if (s.step === "what") {
    s.what = text;

    try {
      const r = await sendToSheet(s);
      if (!r.ok) throw new Error(r.error || "unknown error");
      await ctx.reply("Записано.", mainKeyboard());
    } catch (e) {
      await ctx.reply(`Ошибка: ${e?.message || e}`, mainKeyboard());
    }

    sessions.delete(ctx.from.id);
  }
});

bot.on("callback_query", async (ctx) => {
  const userId = ctx.from.id;
  const s = sessions.get(userId);
  const data = ctx.callbackQuery.data || "";

  if (data === "cancel") {
    sessions.delete(userId);
    await ctx.answerCbQuery("Ок");
    await ctx.editMessageText("Отменено.");
    await ctx.reply("Готово.", mainKeyboard());
    return;
  }

  // выбор типа
  if (data === "t:expense" || data === "t:revenue") {
    const type = data.split(":")[1]; // expense | revenue
    if (!s) sessions.set(userId, { step: "date", date: todayDDMMYYYY(), type });
    else {
      s.type = type;
      s.step = "date";
      if (!s.date) s.date = todayDDMMYYYY();
    }

    await ctx.answerCbQuery("Ок");
    await ctx.editMessageText(type === "expense" ? "Затраты" : "Выручка");
    await ctx.reply("Дата? (ДД.ММ или ДД.ММ.ГГГГ)");
    return;
  }

  // выбор группы (только для затрат)
  if (data.startsWith("g:")) {
    if (!s || s.type !== "expense") {
      await ctx.answerCbQuery("Нет активной операции");
      return;
    }
    s.group = data.slice(2);
    s.step = "what";

    await ctx.answerCbQuery("Ок");
    await ctx.editMessageText(`Группа: ${s.group}`);
    await ctx.reply("За что?");
    return;
  }
});

bot.launch();
console.log("Bot started");
