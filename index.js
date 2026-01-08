import "dotenv/config";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SCRIPT_URL = process.env.SCRIPT_URL;
const TOKEN = process.env.TOKEN;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!SCRIPT_URL) throw new Error("SCRIPT_URL missing");
if (!TOKEN) throw new Error("TOKEN missing");

const GROUPS = [
  "поставщик","зп","возврат Илье","инструм для раб","командировки","склад",
  "налоги","доставка","разведка","подарки клиентам","бензин и то","транс комп","сайт","ИИ",
];

const sessions = new Map(); // userId -> draft

function todayDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
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
  return Markup.inlineKeyboard(rows);
}

async function sendToSheet(exp) {
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: TOKEN,
      date: exp.date,
      amount: exp.amount,
      whom: exp.whom,
      group: exp.group,
      what: exp.what,
    }),
  });
  return await res.json();
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("Я бот затрат. Команды: /add (добавить расход), /cancel (отмена)");
});

bot.command("cancel", (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply("Ок, отменил.");
});

bot.command("add", (ctx) => {
  sessions.set(ctx.from.id, { step: "amount", date: todayDDMMYYYY() });
  ctx.reply("Сумма? (только число, например 1200)");
});

bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const text = ctx.message.text.trim();

  if (s.step === "amount") {
    const val = Number(text.replace(",", "."));
    if (!Number.isFinite(val)) return ctx.reply("Нужно число. Пример: 1200");
    s.amount = val;
    s.step = "whom";
    return ctx.reply("Кому? (например: Лукойл / Яндекс / Илья)");
  }

  if (s.step === "whom") {
    s.whom = text;
    s.step = "group";
    return ctx.reply("Выбери группу:", groupsKeyboard());
  }

  if (s.step === "what") {
    s.what = text;

    try {
      const r = await sendToSheet(s);
      if (!r.ok) throw new Error(r.error || "unknown error");
      await ctx.reply(`✅ Записал: ${s.date} | ${s.amount} | ${s.group}`);
    } catch (e) {
      await ctx.reply("❌ Не записалось. Проверь SCRIPT_URL/TOKEN и Deploy в Apps Script.");
    }

    sessions.delete(ctx.from.id);
    return;
  }
});

bot.on("callback_query", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const data = ctx.callbackQuery.data || "";
  if (!data.startsWith("g:")) return;

  s.group = data.slice(2);
  s.step = "what";

  await ctx.answerCbQuery("Ок");
  await ctx.editMessageText(`Группа: ${s.group}\nТеперь напиши: За что? (например: “пленка на склад”)`);
});
import http from "http";

const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}).listen(port);

bot.launch();
console.log("Bot started");
