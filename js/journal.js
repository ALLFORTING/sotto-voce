import { currency, esc, formatDate, icon, phone, subpageTop, tokenCount } from "./components.js";
import { store } from "./store.js";

export function renderJournalHome() {
  const cards = [
    ["/journal/calendar", "日历", "我们的日子 · 打卡、待办与里程碑", "calendar"],
    ["/journal/books", "伴读", "一起读一本书，读到哪都能停下来聊", "bookOpen"],
    ["/journal/ledger", "账本", "每一轮对话花了多少", "ledger"]
  ];
  const body = `<main class="page">
    <h1 class="page-title">手记</h1>
    <section class="jnl-home">
      ${cards.map(([path, name, desc, ico]) => `<button class="jnl-card" data-go="${path}">
        <span class="txt"><span class="nm">${name}</span><span class="desc">${desc}</span></span>
        <span class="ic">${icon(ico)}</span>
      </button>`).join("")}
    </section>
  </main>`;
  return phone({ activeTab: "jnl", body });
}

function monthEnglish(month) {
  const [year, m] = month.split("-");
  const name = new Date(`${month}-01T00:00:00+08:00`).toLocaleString("en-US", { month: "long" });
  return { year, name };
}

function todayChina() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function selectedCalendarDate() {
  if (!store.calendarSelectedDate?.startsWith(store.calendarMonth)) {
    const today = todayChina();
    store.calendarSelectedDate = today.startsWith(store.calendarMonth) ? today : `${store.calendarMonth}-01`;
  }
  return store.calendarSelectedDate;
}

function dateLabel(date) {
  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai"
  });
}

function selectedDayDetails(data, selectedDate) {
  return {
    checkin: (data.checkins || []).find((item) => item.date === selectedDate),
    todos: (data.todos || []).filter((todo) => todo.due_date === selectedDate),
    milestones: (data.milestones || []).filter((item) => item.date === selectedDate),
    anniversaries: (data.anniversaries || []).filter((item) => String(item.date || "").slice(5) === selectedDate.slice(5))
  };
}

function calendarCells(month, data) {
  const [year, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, m - 1, 1));
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const heat = new Map((data.checkins || []).map((item) => [Number(item.date.slice(-2)), 2]));
  const annivDays = new Set((data.anniversaries || []).map((item) => Number(item.date.slice(-2))));
  const today = todayChina();
  const selected = selectedCalendarDate();
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push(`<div class="cal-cell muted"></div>`);
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const heatLevel = heat.get(day);
    cells.push(`<button class="cal-cell ${date === today ? "today" : ""} ${date === selected ? "selected" : ""} ${annivDays.has(day) ? "anniv" : ""}" data-calendar-date="${date}">
      <span class="d">${day}</span>${heatLevel ? `<span class="heat-dot s${heatLevel}"></span>` : ""}
    </button>`);
  }
  return cells.join("");
}

export function renderCalendar() {
  const data = store.calendar || { checkins: [], todos: [], milestones: [], anniversaries: [], streak: 0 };
  const { year, name } = monthEnglish(store.calendarMonth);
  const selectedDate = selectedCalendarDate();
  const today = todayChina();
  const details = selectedDayDetails(data, selectedDate);
  const hasCheckin = Boolean(details.checkin);
  const isToday = selectedDate === today;
  const checkinTitle = hasCheckin
    ? (isToday ? "今天已记下" : "这天已记下")
    : (isToday ? "今天还没记" : "这天还没有打卡记录");
  const checkinSubtitle = hasCheckin
    ? (details.checkin?.note || "连续陪伴，没有断过")
    : (isToday ? "轻轻点一下，留下今天" : "点击日期查看那一天的记录");
  const body = `<main class="page">
    ${subpageTop("日历")}
    <section class="jnl-scroll">
      <div class="cal-head">
        <div class="cal-title"><span class="m">${name}</span><span class="y">${year}</span></div>
        <div class="arrows"><button data-action="prev-month">${icon("chevL")}</button><button data-action="next-month">${icon("chevR")}</button></div>
      </div>
      <div class="cal-grid">
        ${["一", "二", "三", "四", "五", "六", "日"].map((d) => `<div class="wd">${d}</div>`).join("")}
        ${calendarCells(store.calendarMonth, data)}
      </div>
      <div class="day-detail-head"><span>${esc(dateLabel(selectedDate))}</span><span>${isToday ? "今天" : selectedDate}</span></div>
      <button class="checkin" ${isToday ? 'data-action="checkin"' : ""}>
        <span class="ring">${icon("check")}</span>
        <span class="info"><span class="t">${checkinTitle}</span><span class="s">${esc(checkinSubtitle)}</span></span>
        <span class="streak">${data.streak || 0}<span class="u">天</span></span>
      </button>
      <div class="jnl-block-h"><span>待办 · TODO</span><button data-action="quick-todo">${icon("plus")}</button></div>
      ${details.todos.length ? details.todos.map((todo) => `<button class="todo-item ${todo.done ? "done" : ""}" data-todo="${todo.id}">
        <span class="todo-check"></span><span>${esc(todo.content)}</span>
      </button>`).join("") : `<div class="todo-item empty"><span class="todo-check"></span><span>这一天没有待办。</span></div>`}
      <div class="jnl-block-h"><span>里程碑 · MILESTONES</span><button data-action="quick-milestone">${icon("plus")}</button></div>
      <div class="milestones">
        ${details.milestones.length ? details.milestones.map((item, index) => `<div class="ms-item ${index === 0 ? "filled" : ""}">
          <div class="date">${esc(item.date.replaceAll("-", " · "))}</div><div>${esc(item.title || item.name || "")}</div>
        </div>`).join("") : `<div class="ms-item empty">这一天没有里程碑。</div>`}
        ${details.anniversaries.map((item) => `<div class="ms-item filled anniversary"><div class="date">${esc(item.date.replaceAll("-", " · "))}</div><div>${esc(item.name)}</div></div>`).join("")}
      </div>
    </section>
  </main>`;
  return phone({ activeTab: "jnl", body });
}

export function renderShelf() {
  const books = store.books || [];
  const uploadIcon = `<label class="up-ic"><input hidden type="file" accept=".txt,text/plain" data-upload-book>${icon("upload")}</label>`;
  const body = `<main class="page">
    ${subpageTop("伴读", books.length ? uploadIcon : "")}
    ${books.length ? `<section class="cv2-list jnl-scroll">
      ${books.map((book) => {
        const page = book.current_page || 1;
        const total = book.total_pages || 1;
        const pct = Math.round((page / total) * 100);
        const done = page >= total;
        return `<button class="cv2-book" data-go="/journal/books/${book.id}">
          <div class="head"><span class="bt">${esc(book.title)}</span><span class="pg">第 ${page} 页 / 共 ${total} 页</span></div>
          <div class="prog"><div class="fill" style="width:${pct}%"></div></div>
          <div class="last">${done ? "已读完" : ""} ${book.last_read_at ? formatDate(book.last_read_at) : ""}</div>
        </button>`;
      }).join("")}
      <label class="cv2-up-card"><input hidden type="file" accept=".txt,text/plain" data-upload-book>${icon("upload")} 上传新书</label>
    </section>` : `<section class="cv2-empty">
      <div class="ico">${icon("book")}</div>
      <div class="txt">还没有正在读的书。\n上传一本，我陪你读。</div>
      <label class="up-btn"><input hidden type="file" accept=".txt,text/plain" data-upload-book>${icon("upload")} 上传新书</label>
    </section>`}
  </main>`;
  return phone({ activeTab: "jnl", hideTab: true, body });
}

export function renderReader() {
  const item = store.currentBook;
  if (!item) return phone({ activeTab: "jnl", hideTab: true, body: `<div class="loading-text">正在翻书…</div>` });
  const book = item.book;
  const chapter = item.chapter;
  const progress = Math.round(Number(book.progress || 0) * 100);
  const paragraphs = String(chapter.content || "这里还没有章节内容。")
    .split(/\n{2,}|\n/)
    .filter(Boolean)
    .slice(0, 12);
  const body = `<main class="page">
    <header class="reader-top">
      <button class="ic" data-action="back">${icon("back")}</button>
      <div class="bt">${esc(book.title)}</div>
      <button class="ic" data-action="reader-font">${icon("textSize")}</button>
    </header>
    <section class="reader-body">
      <div class="chap">${esc(chapter.title || `第 ${chapter.index} 章`)}</div>
      ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}
    </section>
    <footer class="reader-foot">
      <div class="pbar-row"><span>${progress}%</span><span class="pbar"><span class="fill" style="width:${progress}%"></span><span class="knob" style="left:${progress}%"></span></span><span>第 ${chapter.index} / ${book.total_chapters} 章</span></div>
      <button class="discuss" data-action="discuss-book">${icon("chat")} 聊聊这段</button>
    </footer>
  </main>`;
  return phone({ activeTab: "jnl", hideTab: true, body });
}

function statCard(label, data) {
  return `<section class="ledger-card">
    <div class="lbl">${label}</div>
    <div class="amt"><span class="cu">$</span>${Number(data.cost || 0).toFixed(2)}</div>
    <div class="rows">
      <span>对话 ${data.rounds || 0} 轮</span>
      <span>Input ${tokenCount(data.input_tokens)} tok</span>
      <span>Output ${tokenCount(data.output_tokens)} tok</span>
      <span>缓存 R/W ${tokenCount(data.cache_read_tokens || data.cache_read)} / ${tokenCount(data.cache_write_tokens || data.cache_write)}</span>
    </div>
  </section>`;
}

export function renderLedger() {
  const summary = store.usageSummary || { today: {}, total: {} };
  const detail = store.usageDetail || { logs: [] };
  const body = `<main class="page">
    ${subpageTop("账本")}
    <section class="jnl-scroll">
      <div class="ledger-stats">${statCard("TODAY", summary.today || {})}${statCard("TOTAL", summary.total || {})}</div>
      <div class="ledger-list-head">单次对话</div>
      <div class="ledger-list">
        ${(detail.logs || []).map((log) => `<div class="ledger-row">
          <div class="row-top"><span>${formatDate(log.created_at)} · <span class="iface">${esc(log.preset_name || log.model || "接口")}</span></span><span class="cost">${currency(log.cost)}</span></div>
          <div class="row-bot">↑${tokenCount(log.input_tokens)} · ↓${tokenCount(log.output_tokens)} · 缓存 ${tokenCount(log.cache_read_tokens || log.cache_read || 0)}</div>
        </div>`).join("") || `<div class="ledger-row"><div class="row-top"><span>今天 21:42 · <span class="iface">OpenRouter</span></span><span class="cost">$0.12</span></div><div class="row-bot">↑1240 · ↓892 · 命中 540</div></div>`}
      </div>
    </section>
  </main>`;
  return phone({ activeTab: "jnl", hideTab: true, body });
}
