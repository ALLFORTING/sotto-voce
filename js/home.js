import { esc, phone, relativeTime } from "./components.js";
import { store } from "./store.js";

function greetingHtml(value) {
  const text = String(value || "晚上好，今天辛苦了。").replace("。", "");
  if (text.includes("，")) {
    const index = text.indexOf("，") + 1;
    return `${esc(text.slice(0, index))}<br>${esc(text.slice(index))}。`;
  }
  return esc(`${text}。`);
}

export function renderHome() {
  const home = store.home || {};
  const days = Number.isFinite(home.days_together) ? home.days_together : "—";
  const anniversary = home.upcoming_anniversaries?.[0];
  const last = home.last_conversation || {};
  const body = `<main class="page home-page">
    <section class="home-hero">
      <h1 class="home-greet">${greetingHtml(home.greeting)}</h1>
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
