import { esc, phone, relativeTime } from "./components.js";
import { store } from "./store.js";

function greetingHtml() {
  const hour = new Date().getHours();
  const greetings = {
    morning: [
      "醒了。今天想做什么。",
      "早。昨晚睡得好吗。",
      "起来了。慢慢来，不急。",
      "醒了啊。先喝口水吧。",
      "起来了。今天也要好好的。",
    ],
    noon: [
      "中午好。别光顾着忙，忘了吃饭。",
      "中午了。今天吃的什么。",
      "饿了吧。先去吃饭再说。",
      "午安。吃完饭休息一下。",
      "中午好。有没有好好吃饭。",
    ],
    afternoon: [
      "下午好。累了就歇一会儿。",
      "困了吧。趴一会儿也行。",
      "还在忙。记得喝水。",
      "下午了。今天顺利吗。",
      "来了。今天下午想干嘛。",
    ],
    evening: [
      "回来了。今天辛苦了。",
      "晚上了。今天还顺利吗。",
      "到家了。想吃点什么。",
      "晚上好。放松一下吧。",
      "累了吧。回来就好好歇着。",
    ],
    night: [
      "还没睡。陪你聊会儿。",
      "困不困。睡不着就聊聊。",
      "嘿。我也还没睡。",
      "夜深了。不困就再待会儿。",
      "还没困。那我陪着你。",
    ],
  };
  let pool;
  if (hour >= 5 && hour < 11) pool = greetings.morning;
  else if (hour >= 11 && hour < 14) pool = greetings.noon;
  else if (hour >= 14 && hour < 18) pool = greetings.afternoon;
  else if (hour >= 18 && hour < 23) pool = greetings.evening;
  else pool = greetings.night;
  const text = pool[Math.floor(Math.random() * pool.length)];
  const parts = text.split("。").filter(Boolean);
  if (parts.length >= 2) {
    return `<h1 class="home-greet">${parts[0]}，<br>${parts[1]}。</h1>`;
  }
  return `<h1 class="home-greet">${text}</h1>`;
}

export function renderHome() {
  const home = store.home || {};
  const days = Number.isFinite(home.days_together) ? home.days_together : "—";
  const anniversary = home.upcoming_anniversaries?.[0];
  const last = home.last_conversation || {};
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
      <div class="body">${esc(last.summary || "关于那本读到一半的《地下室手记》，你说陀思妥耶夫斯基写人比镜子还狠。我们停在你说明天再读两章那里。")}</div>
    </button>
    <button class="anniv-hint" data-go="/journal/calendar">
      <span class="dot"></span>
      ${anniversary ? `还有 ${anniversary.days_until} 天，是${esc(anniversary.name)}` : "还有 6 天，是认识两周年"}
    </button>
    <section class="today-memory">
      <div class="lab">今日回忆 · TODAY</div>
      <div>${esc(home.today_memory || "5 月 27 日，你第一次给我放歌，选的是 Laufey。")}</div>
    </section>
  </main>`;
  return phone({ activeTab: "home", body });
}
