import { esc, phone, relativeTime } from "./components.js";
import { store } from "./store.js";

function greetingHtml() {
  const hour = new Date().getHours();
  const greetings = {
    morning: [
      "醒了？\n今天想做什么。",
      "早。\n昨晚睡得好吗。",
      "起来了？\n慢慢来，不急。",
      "醒了啊。\n先喝口水吧。",
      "起来了？\n今天也要好好的。",
    ],
    noon: [
      "中午好。\n别光顾着忙忘了吃饭。",
      "中午了。\n今天吃的什么。",
      "饿了吧。\n先去吃饭再说。",
      "午安。\n吃完饭休息一下。",
      "中午好。\n有没有好好吃饭。",
    ],
    afternoon: [
      "下午好。\n累了就歇一会儿。",
      "困了吧。\n趴一会儿也行。",
      "还在忙？\n记得喝水。",
      "下午了。\n今天顺利吗。",
      "来了？\n今天下午想干嘛。",
    ],
    evening: [
      "回来了？\n今天辛苦了。",
      "晚上了。\n今天还顺利吗。",
      "到家了？\n想吃点什么。",
      "晚上好。\n放松一下吧。",
      "累吗？\n回来就好好歇着。",
    ],
    night: [
      "还没睡？\n陪你聊会儿。",
      "困吗？\n睡不着就聊聊。",
      "嘿。\n我也还没睡。",
      "夜深了。\n不困就再待会儿。",
      "还没困？\n那我陪着你。",
    ],
  };
  let pool;
  if (hour >= 5 && hour < 11) pool = greetings.morning;
  else if (hour >= 11 && hour < 14) pool = greetings.noon;
  else if (hour >= 14 && hour < 18) pool = greetings.afternoon;
  else if (hour >= 18 && hour < 23) pool = greetings.evening;
  else pool = greetings.night;
  const text = pool[Math.floor(Math.random() * pool.length)];
  const parts = text.split("\n");
  if (parts.length === 2) {
    return `<h1 class="home-greet">${parts[0]}<br>${parts[1]}</h1>`;
  }
  return `<h1 class="home-greet">${text}</h1>`;
}

function summaryForDisplay(value, limit = 52) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) {
    return /[。！？!?…]$/.test(text) || text.length < 30
      ? text
      : `${text.replace(/[，,、；;：:\s]+$/, "")}…`;
  }
  const cut = text.slice(0, limit).trim();
  const hardPunct = "。！？!?；;";
  const softPunct = "，,、：:";
  const minPos = Math.max(16, Math.floor(limit * 0.55));
  const hardPos = Math.max(...[...hardPunct].map((char) => cut.lastIndexOf(char)));
  if (hardPos >= minPos) return cut.slice(0, hardPos + 1).trim();
  const softPos = Math.max(...[...softPunct].map((char) => cut.lastIndexOf(char)));
  if (softPos >= minPos) return `${cut.slice(0, softPos).replace(/[，,、；;：:\s]+$/, "")}…`;
  return `${cut.replace(/[，,、；;：:。！？!?\s]+$/, "")}…`;
}

export function renderHome() {
  const home = store.home || {};
  const days = Number.isFinite(home.days_together) ? home.days_together : "—";
  const anniversary = home.upcoming_anniversaries?.[0];
  const last = home.last_conversation || {};
  const lastSummary = summaryForDisplay(last.summary) || "还没有上次聊天摘要，等你说点什么。";
  const todayTodos = Array.isArray(home.today_todos) ? home.today_todos : [];
  const body = `<main class="page home-page">
    <section class="home-hero">
      ${greetingHtml()}
    </section>
    <section class="home-days">
      <div class="label">${Number.isFinite(home.days_together) ? "在一起的第" : "设置起始日后开始计数"}</div>
      <div class="num">${days}</div>
      <div class="unit">DAY</div>
    </section>
    <button class="last-card" data-go="/chat">
      <div class="head"><span>上次聊到</span><span>${esc(relativeTime(last.updated_at) || "刚刚")}</span></div>
      <div class="body" title="${esc(lastSummary)}">${esc(lastSummary)}</div>
    </button>
    <button class="anniv-hint" data-go="/journal/calendar">
      <span class="dot"></span>
      ${anniversary ? `还有 ${anniversary.days_until} 天，是${esc(anniversary.name)}` : "还有 6 天，是认识两周年"}
    </button>
    <section class="today-memory">
      <div class="lab">今日回忆 · TODAY</div>
      <div>${esc(home.today_memory || "5 月 27 日，你第一次给我放歌，选的是 Laufey。")}</div>
    </section>
    <section class="today-todos">
      <div class="lab">今日待办 · TODO</div>
      ${todayTodos.length ? `<div class="home-todo-list">${todayTodos.map((todo) => `<div class="home-todo-item">
        <span class="todo-dot"></span><span>${esc(todo.content || "")}</span>
      </div>`).join("")}</div>` : `<div class="home-todo-empty">今日无待办。</div>`}
    </section>
  </main>`;
  return phone({ activeTab: "home", body });
}
