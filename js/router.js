import { api, streamChat } from "./api.js";
import {
  errorPage,
  esc,
  formValue,
  icon,
  loadingPage,
  phone,
  subpageTop,
  tokenGate,
  toast
} from "./components.js";
import {
  cacheFresh,
  cacheMessages,
  clearToken,
  invalidateHomeCache,
  rememberConversation,
  saveArchiveCache,
  saveConversationsCache,
  saveHomeCache,
  saveMemoryCache,
  setTheme,
  setToken,
  store,
  updateThemeMeta,
  VERSION
} from "./store.js";
import { renderHome } from "./home.js";
import {
  appendStreamText,
  renderChat,
  renderDrawer,
  renderLongPressMenu,
  scrollChat,
  updateAutoFollow,
  updateThoughtDom,
  updateStreamMeta
} from "./chat.js";
import {
  renderCalendar,
  renderJournalHome,
  renderLedger,
  renderReader,
  renderShelf
} from "./journal.js";
import { renderMemory } from "./memory.js";
import {
  renderAnniversaries,
  renderApiSettings,
  renderMcpSettings,
  renderPrompt,
  renderSettings,
  renderTerminal
} from "./settings.js";

const app = document.querySelector("#app");
let navigationId = 0;
let longPressTimer = 0;
let longPressStart = null;
let suppressBookCardClick = false;
let jumpClearTimer = 0;
const SEARCH_CALENDAR_START = "2026-01";

const CACHE_MS = {
  home: 5 * 60_000,
  conversations: 2 * 60_000,
  messages: 2 * 60_000,
  calendar: 5 * 60_000,
  books: 5 * 60_000,
  usage: 5 * 60_000,
  settings: 5 * 60_000,
  memories: 60_000,
  archives: 60_000
};

function route() {
  return location.hash.slice(1) || "/";
}

function go(path) {
  if (route() === path) return;
  location.hash = path;
}

function render(html) {
  app.innerHTML = html;
  requestAnimationFrame(() => {
    if (route() === "/chat" && store.pendingJumpMessageId) schedulePendingMessageJump();
    else scrollChat();
  });
}

function summaryLooksHardCut(value) {
  const text = String(value || "").trim();
  if (!text || /[。！？!?…]$/.test(text)) return false;
  return text.length >= 30;
}

function homeSummaryLooksHardCut() {
  return summaryLooksHardCut(store.home?.last_conversation?.summary);
}

async function loadHome(force = false) {
  if (!force && store.home && Array.isArray(store.home.today_todos) && cacheFresh("home", CACHE_MS.home) && !homeSummaryLooksHardCut()) return;
  saveHomeCache(await api.get("/api/home"));
}

async function loadConversations(force = false) {
  if (!force && store.conversations.length && cacheFresh("conversations", CACHE_MS.conversations)) return;
  saveConversationsCache(await api.get("/api/conversations"));
  if (store.conversationId && !store.conversations.some((item) => item.id === store.conversationId)) {
    rememberConversation(store.conversations[0]?.id || null);
  }
  if (!store.conversationId && store.conversations.length) rememberConversation(store.conversations[0].id);
}

async function loadMessages(force = false) {
  if (!store.conversationId) {
    store.messages = [];
    store.editingMessageId = null;
    store.editingMessageDraft = "";
    return;
  }
  if (!force && store.messageCache[store.conversationId] && Date.now() - (store.cacheAt.messages[store.conversationId] || 0) < CACHE_MS.messages) {
    store.messages = store.messageCache[store.conversationId];
    return;
  }
  store.messages = await api.get(`/api/conversations/${store.conversationId}/messages`);
  cacheMessages(store.conversationId, store.messages);
}

async function loadCalendar(force = false) {
  if (!force && store.calendar && cacheFresh("calendar", CACHE_MS.calendar)) return;
  store.calendar = await api.get(`/api/calendar?month=${encodeURIComponent(store.calendarMonth)}`);
  store.cacheAt.calendar = Date.now();
}

async function loadBooks(force = false) {
  if (!force && store.books.length && cacheFresh("books", CACHE_MS.books)) return;
  store.books = await api.get("/api/books");
  store.cacheAt.books = Date.now();
}

async function loadBook(id) {
  store.bookData = await api.get(`/api/books/${id}/all`);
}

async function loadUsage(force = false) {
  if (!force && store.usageSummary && store.usageDetail && cacheFresh("usage", CACHE_MS.usage)) return;
  const [summary, detail] = await Promise.all([
    api.get("/api/usage/summary"),
    api.get("/api/usage/detail?days=7")
  ]);
  store.usageSummary = summary;
  store.usageDetail = detail;
  store.cacheAt.usage = Date.now();
}

async function refreshMemoryBuckets() {
  const data = await api.get("/api/memory/buckets");
  saveMemoryCache(data.buckets || []);
  if (route() === "/memory") render(renderMemory("bucket"));
}

async function loadMemoryBucketDetail(bucketKeyValue) {
  store.bucketDetailLoading = true;
  render(renderMemory("bucket"));
  try {
    const detail = await api.get(`/api/memory/buckets/${encodeURIComponent(bucketKeyValue)}`);
    const nextBucket = detail.bucket || {};
    store.memories = (store.memories || []).map((item) => (
      String(item.id || "") === String(nextBucket.id || bucketKeyValue)
        || String(item.name || item.title || "") === String(bucketKeyValue)
        ? { ...item, ...nextBucket }
        : item
    ));
    saveMemoryCache(store.memories);
  } catch (error) {
    toast(error.message);
  } finally {
    store.bucketDetailLoading = false;
    if (store.bucketEdit === bucketKeyValue && route() === "/memory") render(renderMemory("bucket"));
  }
}

async function refreshMemoryArchives() {
  store.archiveLoading = true;
  if (route() === "/memory/archive") render(renderMemory("archive"));
  try {
    const [archives, trend] = await Promise.all([
      api.get("/api/memory/archives"),
      api.get("/api/memory/emotion_trend")
    ]);
    saveArchiveCache(archives.archives || [], trend.points || []);
  } finally {
    store.archiveLoading = false;
    if (route() === "/memory/archive") render(renderMemory("archive"));
  }
}

async function loadMemory(mode, force = false) {
  if (mode === "archive") {
    if (store.archives.length && !force) {
      if (!cacheFresh("archives", CACHE_MS.archives)) refreshMemoryArchives().catch(console.warn);
      return;
    }
    if (!force) {
      refreshMemoryArchives().catch((error) => {
        store.archiveLoading = false;
        console.warn(error);
        if (route() === "/memory/archive") render(renderMemory("archive"));
      });
      return;
    }
    await refreshMemoryArchives();
    return;
  }
  if (store.memories.length && !force) {
    if (!cacheFresh("memories", CACHE_MS.memories)) refreshMemoryBuckets().catch(console.warn);
    return;
  }
  if (!force) {
    refreshMemoryBuckets().catch(console.warn);
    return;
  }
  await refreshMemoryBuckets();
}

function hasWarmRouteCache(path) {
  if (path === "/") return Boolean(store.home);
  if (path === "/journal" || path === "/chat/search") return true;
  if (path === "/chat") return Boolean(store.cacheAt.conversations || store.messages.length || store.conversationId);
  if (path === "/journal/calendar") return Boolean(store.calendar);
  if (path === "/journal/books") return Boolean(store.cacheAt.books || store.books.length);
  if (path.startsWith("/journal/books/")) {
    const id = Number(path.split("/").pop());
    return Boolean(store.bookData?.book && Number(store.bookData.book.id) === id);
  }
  if (path === "/journal/ledger") return Boolean(store.usageSummary && store.usageDetail);
  if (path === "/memory") return true;
  if (path === "/memory/archive") return true;
  if (path.startsWith("/settings")) return Object.keys(store.settings).length > 0;
  return false;
}

async function loadSettings(force = false) {
  if (!force && Object.keys(store.settings).length && cacheFresh("settings", CACHE_MS.settings)) return;
  const [settings, presets, mcpServers, anniversaries] = await Promise.all([
    api.get("/api/settings"),
    api.get("/api/presets"),
    api.get("/api/mcp_servers"),
    api.get("/api/anniversaries")
  ]);
  store.settings = settings;
  store.presets = presets;
  store.mcpServers = mcpServers;
  store.anniversaries = anniversaries;
  store.cacheAt.settings = Date.now();
}

function rememberPresetDraft(form) {
  const data = formValue(form);
  const presetId = Number(form.dataset.id || 0);
  if (presetId) {
    const preset = store.presets.find((item) => item.id === presetId);
    if (preset) Object.assign(preset, data);
  } else {
    store.newPresetDraft = { ...(store.newPresetDraft || {}), ...data };
  }
  return data;
}

function renderModelPicker() {
  const picker = store.modelPicker;
  if (!picker) return "";
  const options = store.modelOptions[picker.key] || [];
  const query = String(store.modelFilter || "").trim().toLowerCase();
  const filtered = options.filter((item) =>
    `${item.id || ""} ${item.name || ""}`.toLowerCase().includes(query)
  );
  return `<div class="overlay-scrim" data-action="close-model-picker"></div>
    <section class="model-picker">
      <div class="model-picker-head">
        <div><strong>选择模型</strong><span>${filtered.length} / ${options.length}</span></div>
        <button data-action="close-model-picker">×</button>
      </div>
      <input class="model-filter" id="model-filter" value="${esc(store.modelFilter || "")}" placeholder="搜索模型名称">
      <div class="model-list">
        ${filtered.map((item) => `<button data-action="choose-model" data-key-id="${picker.key}" data-model-id="${esc(item.id)}">
          <span>${esc(item.name || item.id)}</span>
          <em>${esc(item.id)}</em>
        </button>`).join("") || `<div class="model-empty">没有匹配的模型</div>`}
      </div>
    </section>`;
}

async function loadTerminalHistory() {
  store.terminalHistory = await api.get("/api/terminal/history");
}

async function createConversation() {
  const item = await api.post("/api/conversations", {});
  rememberConversation(item.id);
  store.conversations.unshift(item);
  store.messages = [];
  store.editingMessageId = null;
  store.editingMessageDraft = "";
  cacheMessages(item.id, []);
  return item;
}

async function prepare(path) {
  if (path === "/") await loadHome();
  else if (path === "/chat") {
    await loadConversations();
    await loadMessages();
  } else if (path === "/journal/calendar") await loadCalendar();
  else if (path === "/journal/books") await loadBooks();
  else if (path.startsWith("/journal/books/")) await loadBook(path.split("/").pop());
  else if (path === "/journal/ledger") await loadUsage();
  else if (path === "/memory") await loadMemory("bucket");
  else if (path === "/memory/archive") await loadMemory("archive");
  else if (path === "/settings/terminal") await loadTerminalHistory();
  else if (path.startsWith("/settings")) await loadSettings();
}

function renderRoute(path) {
  if (path === "/") return renderHome();
  if (path === "/chat") return renderChat();
  if (path === "/journal") return renderJournalHome();
  if (path === "/journal/calendar") return renderCalendar();
  if (path === "/journal/books") return renderShelf();
  if (path.startsWith("/journal/books/")) return renderReader();
  if (path === "/journal/ledger") return renderLedger();
  if (path === "/memory") return renderMemory("bucket");
  if (path === "/memory/archive") return renderMemory("archive");
  if (path === "/settings") return renderSettings();
  if (path === "/settings/prompt") return renderPrompt();
  if (path === "/settings/api") return renderApiSettings();
  if (path === "/settings/mcp") return renderMcpSettings();
  if (path === "/settings/terminal") return renderTerminal();
  if (path === "/settings/anniv") return renderAnniversaries();
  if (path === "/chat/search") return renderSearchPage();
  return renderHome();
}

function isReaderPath(path = route()) {
  return path.startsWith("/journal/books/") && path !== "/journal/books";
}

function scheduleReaderInit(path = route()) {
  if (isReaderPath(path)) requestAnimationFrame(() => restoreReaderScroll());
}

function currentReaderProgress() {
  const value = parseFloat(document.querySelector(".reader-pct")?.textContent);
  return Number.isFinite(value) ? value : Number(store.bookData?.book?.progress || 0);
}

function syncReaderProgress(pct) {
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  document.querySelectorAll(".reader-pct").forEach((el) => { el.textContent = `${value}%`; });
  const fill = document.querySelector(".reader-fill");
  const thumb = document.querySelector(".reader-thumb");
  if (fill) fill.style.width = `${value}%`;
  if (thumb) thumb.style.left = `${value}%`;
  if (store.bookData?.book) store.bookData.book.progress = value;
  return value;
}

function restoreReaderScroll(progress = Number(store.bookData?.book?.progress || 0)) {
  const body = document.querySelector(".reader-body-v2");
  if (!body) return;
  const pct = syncReaderProgress(progress);
  body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight) * pct / 100;
}

function renderReaderKeepingProgress(progress = currentReaderProgress()) {
  render(renderReader());
  requestAnimationFrame(() => restoreReaderScroll(progress));
}

function handleProgressDrag(event, bar) {
  const touch = event.touches?.[0];
  if (!touch) return;
  const rect = bar.getBoundingClientRect();
  const x = touch.clientX - rect.left;
  const pct = Math.max(0, Math.min(100, Math.round((x / rect.width) * 100)));
  syncReaderProgress(pct);
  const body = document.querySelector(".reader-body-v2");
  if (body) {
    body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight) * pct / 100;
  }
}

function resetSearchState() {
  store.searchQuery = "";
  store.searchMode = "home";
  store.searchGroups = [];
  store.searchDetail = [];
  store.searchMedia = [];
  store.searchCalendarMonths = {};
  store.searchDateGroups = [];
  store.searchConversationTitle = "";
}

function chinaDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month, delta) {
  const [year, index] = String(month).split("-").map(Number);
  const date = new Date(year || new Date().getFullYear(), (index || 1) - 1 + delta, 1);
  return monthKey(date);
}

function monthLabel(month) {
  const [year, index] = String(month).split("-").map(Number);
  return `${year}年${index}月`;
}

function searchTimelineMonths() {
  const [startYear, startMonth] = SEARCH_CALENDAR_START.split("-").map(Number);
  const [endYear, endMonth] = monthKey().split("-").map(Number);
  const diff = (endYear - startYear) * 12 + (endMonth - startMonth);
  const count = Math.max(1, diff + 1);
  return Array.from({ length: count }, (_, index) => shiftMonth(SEARCH_CALENDAR_START, index));
}

function searchDateLabel(value) {
  const date = chinaDate(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (day >= weekStart) return weekday;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return "本月";
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月`;
}

function mediaGroupLabel(value) {
  const date = chinaDate(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (day >= weekStart) return "本周";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return "本月";
  return "更早";
}

function searchTime(value) {
  const date = chinaDate(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function searchPreview(item) {
  const text = String(item?.content || "").trim();
  if (text) return text.slice(0, 120);
  const attachments = item?.attachments || [];
  if (attachments.length) return attachments.map((file) => file.name || "附件").join("、").slice(0, 120);
  return "（空消息）";
}

function mediaTiles(items) {
  return items.flatMap((item) => (item.attachments || []).map((file) => ({
    messageId: item.id,
    conversationId: item.conversation_id,
    conversationTitle: item.conversation_title || "新对话",
    createdAt: item.created_at,
    file
  })));
}

function groupedMediaRows(items) {
  const groups = [];
  for (const item of mediaTiles(items)) {
    const label = mediaGroupLabel(item.createdAt);
    let group = groups[groups.length - 1];
    if (!group || group.label !== label) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.map((group) => `<section class="search-section">
    <div class="search-section-title">${esc(group.label)}</div>
    <div class="media-grid">
      ${group.items.map((item) => {
        const file = item.file || {};
        const isImage = file.type === "image" || String(file.mime_type || "").startsWith("image/");
        return `<button class="media-tile ${isImage ? "image" : "file"}" ${isImage ? `data-action="open-media-preview" data-src="${esc(file.path || "")}" data-name="${esc(file.name || "图片")}"` : ""} data-search-message="${item.messageId}" data-search-conversation="${item.conversationId}">
          ${isImage ? `<img src="${esc(file.path || "")}" alt="${esc(file.name || "图片")}" loading="lazy">` : `<span class="file-ico">${icon("file")}</span><span class="file-name">${esc(file.name || "附件")}</span>`}
          <span class="media-meta">${esc(item.conversationTitle)} · ${searchTime(item.createdAt)}</span>
        </button>`;
      }).join("")}
    </div>
  </section>`).join("");
}

function searchCalendarHtml() {
  return searchTimelineCalendarHtml();
}

function searchTimelineCalendarHtml() {
  const todayDate = new Date();
  const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;
  const months = searchTimelineMonths();
  const monthHtml = months.map((month) => {
    const [year, index] = month.split("-").map(Number);
    const first = new Date(year, index - 1, 1);
    const total = new Date(year, index, 0).getDate();
    const offset = first.getDay();
    const counts = new Map((store.searchCalendarMonths?.[month] || []).map((item) => [item.date, item]));
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(`<span class="day ghost"></span>`);
    for (let day = 1; day <= total; day++) {
      const key = `${month}-${String(day).padStart(2, "0")}`;
      const hit = counts.get(key);
      cells.push(`<button class="day timeline-day ${hit ? "has" : ""} ${key === today ? "today" : ""}" data-search-day="${key}" aria-label="${key}">
        <span>${day}</span>${hit ? `<i>${hit.count}</i>` : ""}
      </button>`);
    }
    return `<section class="search-month-block" data-month="${month}">
      <div class="search-month-title">${monthLabel(month)}</div>
      <div class="days search-month-days">${cells.join("")}</div>
    </section>`;
  }).join("");
  return `<section class="search-calendar continuous">
    <div class="week search-week-sticky"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="search-calendar-list">${monthHtml}</div>
  </section>`;
}

function renderSearchPage() {
  let rows = "";
  if (store.searchMode === "keyword-groups") {
    rows = store.searchGroups.length ? store.searchGroups.map((group) => `<button class="search-result grouped" data-search-group="${group.conversation_id}">
      <span class="top"><span class="who">${esc(group.conversation_title || "新对话")}</span><span>${group.count} 条</span></span>
      <span class="body">${esc(searchPreview(group.preview))}</span>
      <span class="meta">共 ${group.count} 条相关的聊天记录</span>
    </button>`).join("") : `<div class="loading-text">没有找到相关聊天记录。</div>`;
  } else if (store.searchMode === "keyword-detail") {
    rows = `<div class="search-detail-title">${esc(store.searchConversationTitle || "聊天记录")}</div>${store.searchDetail.map((item) => `<button class="search-result" data-search-message="${item.id}" data-search-conversation="${item.conversation_id}">
      <span class="top"><span class="who">${item.role === "assistant" ? "澄" : "我"}</span><span>${searchTime(item.created_at)}</span></span>
      <span class="body">${esc(searchPreview(item))}</span>
    </button>`).join("") || `<div class="loading-text">没有找到相关聊天记录。</div>`}`;
  } else if (store.searchMode === "image" || store.searchMode === "file") {
    rows = store.searchMedia.length ? groupedMediaRows(store.searchMedia) : `<div class="loading-text">还没有找到${store.searchMode === "image" ? "图片" : "文件"}。</div>`;
  } else if (store.searchMode === "date") {
    rows = searchTimelineCalendarHtml();
  } else {
    rows = `<div class="loading-text">输入关键词后回车搜索，或选择文件、图片、日期。</div>`;
  }
  const body = `<main class="page">
    ${subpageTop("搜索聊天")}
    <form id="chat-search-form" class="chat-search-form"><input name="q" value="${esc(store.searchQuery || "")}" placeholder="搜索聊天"></form>
    <div class="chat-filter-row"><button class="chip" data-action="search-media" data-kind="file">文件</button><button class="chip" data-action="search-media" data-kind="image">图片</button><button class="chip" data-action="search-date-mode">日期</button></div>
    <section class="scroll" id="search-results">${rows || '<div class="loading-text">输入关键词后回车搜索。</div>'}</section>
  </main>`;
  return phone({ activeTab: "chat", hideTab: true, body });
}

async function loadSearchMonth(month = store.searchMonth) {
  store.searchMonth = month;
  store.searchMonthDays = await api.get(`/api/search?type=dates&month=${encodeURIComponent(month)}`);
}

async function loadSearchCalendarTimeline() {
  const months = searchTimelineMonths();
  store.searchMonth = months[0];
  const current = { ...(store.searchCalendarMonths || {}) };
  await Promise.all(months.map(async (month) => {
    if (current[month]) return;
    try {
      current[month] = await api.get(`/api/search?type=dates&month=${encodeURIComponent(month)}`);
    } catch (error) {
      current[month] = [];
      console.warn(error);
    }
  }));
  store.searchCalendarMonths = current;
}

function schedulePendingMessageJump(attempt = 0) {
  const id = store.pendingJumpMessageId;
  if (!id) return scrollChat();
  const target = document.querySelector(`[data-message-id="${id}"]`);
  if (!target) {
    if (attempt < 8) setTimeout(() => schedulePendingMessageJump(attempt + 1), 80);
    else {
      store.pendingJumpMessageId = null;
      scrollChat();
      toast("没有找到这条消息");
    }
    return;
  }
  target.scrollIntoView({ block: "center" });
  target.classList.add("jump-highlight");
  clearTimeout(jumpClearTimer);
  jumpClearTimer = setTimeout(() => {
    target.classList.remove("jump-highlight");
    if (store.pendingJumpMessageId === id) store.pendingJumpMessageId = null;
  }, 1800);
}

async function scrollToMessage(conversationId, messageId) {
  store.pendingJumpMessageId = Number(messageId);
  rememberConversation(Number(conversationId));
  await loadMessages(true);
  go("/chat");
  if (route() === "/chat") render(renderChat());
}

async function navigate() {
  const id = ++navigationId;
  const path = route();
  const previousPath = store.route;
  store.route = path;
  if (path === "/chat/search" && previousPath !== path) resetSearchState();
  updateThemeMeta();
  if (!store.token) {
    render(tokenGate());
    return;
  }
  if (path === "/memory/archive" && !store.archives.length) store.archiveLoading = true;
  if (hasWarmRouteCache(path)) {
    render(renderRoute(path));
    scheduleReaderInit(path);
  } else {
    render(loadingPage());
  }
  try {
    await prepare(path);
    if (id !== navigationId || path !== route()) return;
    render(renderRoute(path));
    scheduleReaderInit(path);
  } catch (error) {
    if (id !== navigationId) return;
    render(errorPage(error.message));
  }
}

async function verifyToken(token) {
  setToken(token);
  try {
    await api.get("/api/health");
    await navigate();
  } catch (error) {
    clearToken();
    render(tokenGate(error.message));
  }
}

async function sendMessage(content, attachments = [], options = {}) {
  const regenerating = Boolean(options.messageId);
  const editing = Boolean(options.editMessageId);
  if (!regenerating && !editing && !store.conversationId) await createConversation();
  let userMessage = null;
  const assistant = {
    role: "assistant",
    content: "",
    thinking: "",
    thinkingStarted: false,
    thinking_seconds: 0,
    tools: [],
    streaming: true,
    streamKey: `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`
  };
  if (regenerating || editing) {
    store.messages.splice(options.index, 0, assistant);
  } else {
    userMessage = {
      role: "user",
      content,
      attachments,
      created_at: new Date().toISOString()
    };
    store.messages.push(userMessage, assistant);
  }
  cacheMessages(store.conversationId, store.messages);
  render(renderChat());
  scrollChat(true);

  const pending = {
    text: "",
    thinking: "",
    done: null,
    frame: 0,
    started: false,
    sawThinking: false,
    thinkingEnded: false
  };
  const finalize = async () => {
    if (
      pending.text ||
      pending.thinking ||
      (pending.sawThinking && !pending.thinkingEnded) ||
      !pending.done
    ) return;
    assistant.id = pending.done.message_id;
    assistant.streaming = false;
    assistant.created_at = new Date().toISOString();
    store.contextPct = pending.done.usage?.context_pct || store.contextPct;
    updateStreamMeta(assistant, true);
    await loadConversations(true);
    await loadMessages(true);
    invalidateHomeCache();
  };
  const drain = () => {
    pending.frame = 0;
    if (pending.thinking) {
      const take = Math.max(1, Math.ceil(pending.thinking.length / 90));
      assistant.thinking += pending.thinking.slice(0, take);
      pending.thinking = pending.thinking.slice(take);
      updateStreamMeta(assistant);
    }
    const canRenderText = !pending.sawThinking || (pending.thinkingEnded && !pending.thinking);
    if (pending.text && canRenderText) {
      const take = Math.max(1, Math.ceil(pending.text.length / 90));
      let text = pending.text.slice(0, take);
      pending.text = pending.text.slice(take);
      if (!pending.started) {
        text = text.replace(/^\s+/, "");
        pending.started = Boolean(text);
      }
      assistant.content += text;
      appendStreamText(assistant, text);
    }
    scrollChat();
    if (pending.thinking || (pending.text && canRenderText)) pending.frame = requestAnimationFrame(drain);
    else finalize().catch(console.warn);
  };
  const schedule = () => {
    if (!pending.frame) pending.frame = requestAnimationFrame(drain);
  };
  try {
    await streamChat(
      editing
        ? { message_id: options.editMessageId, content }
        : regenerating
          ? { message_id: options.messageId }
          : { conversation_id: store.conversationId, content, attachments },
      (event, data) => {
        if (event === "user_saved" && userMessage && data.message_id) {
          userMessage.id = data.message_id;
          cacheMessages(store.conversationId, store.messages);
          const index = store.messages.indexOf(userMessage);
          document.querySelector(`[data-message-index="${index}"]`)?.setAttribute("data-message-id", String(data.message_id));
        }
        if (event === "thinking_start") {
          pending.sawThinking = true;
          pending.thinkingEnded = false;
          assistant.thinkingStarted = true;
          updateStreamMeta(assistant);
        }
        if (event === "thinking_delta" && data.text) {
          pending.sawThinking = true;
          if (!pending.thinkingEnded) assistant.thinkingStarted = true;
          pending.thinking += data.text;
          schedule();
        }
        if (event === "thinking_end") {
          pending.sawThinking = true;
          pending.thinkingEnded = true;
          assistant.thinking_seconds = Number(data.seconds || 0);
          assistant.thinkingStarted = false;
          schedule();
        }
        if (event === "tool_use") {
          assistant.tools.push(data.name);
          updateStreamMeta(assistant);
        }
        if (event === "text_delta" && data.text) {
          pending.text += data.text;
          schedule();
        }
        if (event === "done") {
          pending.done = data;
          schedule();
        }
        if (event === "error") throw new Error(data.message);
      },
      editing ? "/api/chat/edit" : regenerating ? "/api/chat/regenerate" : "/api/chat"
    );
  } catch (error) {
    assistant.streaming = false;
    assistant.content = `发送失败：${error.message}`;
    updateStreamMeta(assistant, true);
    toast(error.message);
  }
}

function clearLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = 0;
  longPressStart = null;
}

function clearLongPressActive() {
  document.querySelectorAll(".long-press-active, .long-press-source-hidden").forEach((el) => {
    el.classList.remove("long-press-active", "long-press-source-hidden");
  });
}

function dismissLongPress() {
  store.longPress = null;
  suppressBookCardClick = false;
  clearLongPressActive();
  const overlay = document.querySelector(".phone-overlay-layer");
  if (overlay) overlay.innerHTML = "";
}

function closeAppDialog() {
  const overlay = document.querySelector(".phone-overlay-layer");
  if (!overlay) return;
  overlay.querySelectorAll(".app-dialog-scrim, .app-dialog").forEach((node) => node.remove());
}

function removeLongPressMenuDom() {
  const overlay = document.querySelector(".phone-overlay-layer");
  if (!overlay) return;
  overlay.querySelectorAll(".long-press-menu, .overlay-scrim:not(.app-dialog-scrim)").forEach((node) => node.remove());
}

function refreshDrawerDom() {
  const overlay = document.querySelector(".phone-overlay-layer");
  if (!overlay) return;
  const drawer = overlay.querySelector(".drawer");
  if (!drawer) {
    overlay.insertAdjacentHTML("afterbegin", renderDrawer());
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = renderDrawer();
  const nextList = template.content.querySelector(".drawer-list");
  const currentList = drawer.querySelector(".drawer-list");
  if (currentList && nextList) currentList.innerHTML = nextList.innerHTML;
}

function showAppDialog(html) {
  const overlay = document.querySelector(".phone-overlay-layer");
  if (!overlay) return;
  closeAppDialog();
  overlay.insertAdjacentHTML("beforeend", `<div class="overlay-scrim app-dialog-scrim" data-action="close-dialog"></div>${html}`);
}

function showConversationRenameDialog(item) {
  showAppDialog(`<section class="app-dialog rename-dialog">
      <div class="dialog-title">重命名会话</div>
      <input id="conversation-rename-input" value="${esc(item.title || "")}" placeholder="会话标题">
      <div class="dialog-actions">
        <button class="cancel" data-action="close-dialog">取消</button>
        <button class="ok" data-action="confirm-conversation-rename" data-conversation-id="${item.id}">保存</button>
      </div>
    </section>`);
  requestAnimationFrame(() => document.querySelector("#conversation-rename-input")?.focus());
}

function showConversationDeleteDialog(item) {
  showAppDialog(`<section class="app-dialog">
      <div class="dialog-title">删除这个会话？</div>
      <div class="dialog-text">删除后不会再显示在侧边栏。</div>
      <div class="dialog-actions">
        <button class="cancel" data-action="close-dialog">取消</button>
        <button class="ok danger" data-action="confirm-conversation-delete" data-conversation-id="${item.id}">删除</button>
      </div>
    </section>`);
}

function showJournalInputDialog(type) {
  const todo = type === "todo";
  const title = todo ? "新增待办" : "新增里程碑";
  const placeholder = todo ? "写下今天要做的事…" : "写下这一刻的里程碑…";
  const action = todo ? "confirm-quick-todo" : "confirm-quick-milestone";
  showAppDialog(`<section class="app-dialog journal-input-dialog">
      <div class="dialog-title">${title}</div>
      <input class="dialog-input" id="journal-quick-input" placeholder="${placeholder}">
      <div class="dialog-actions">
        <button class="cancel" data-action="close-dialog">取消</button>
        <button class="ok" data-action="${action}">保存</button>
      </div>
    </section>`);
  requestAnimationFrame(() => document.querySelector("#journal-quick-input")?.focus());
}

document.addEventListener("pointerdown", (event) => {
  const message = event.target.closest(".msg-row[data-message-index]");
  const conversation = event.target.closest(".drawer-item");
  const bookCard = event.target.closest(".cv2-book");
  const annoBlock = event.target.closest(".anno-block");
  if (annoBlock && event.target.closest(".anno-input, .anno-cta")) return;
  if (!message && !conversation && !bookCard && !annoBlock) return;
  clearLongPress();
  longPressStart = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => {
    if (message) {
      message.classList.add("long-press-active");
      const rect = message.getBoundingClientRect();
      const bubble = event.target.closest(".msg-bubble") || message.querySelector(".msg-bubble");
      const bubbleRect = bubble?.getBoundingClientRect() || rect;
      const layerRect = document.querySelector(".phone-overlay-layer")?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const id = Number(message.dataset.messageId || 0);
      const index = Number(message.dataset.messageIndex ?? -1);
      const target = (id && store.messages.find((item) => item.id === id)) || store.messages[index];
      store.longPress = {
        id: target?.id || id || null,
        index,
        role: message.dataset.role,
        starred: Boolean(target?.starred),
        persisted: Boolean(target?.id || id),
        rect: {
          left: rect.left - layerRect.left,
          top: rect.top - layerRect.top,
          bottom: rect.bottom - layerRect.top,
          width: rect.width,
          height: rect.height
        },
        floatRect: {
          left: bubbleRect.left - layerRect.left,
          top: bubbleRect.top - layerRect.top,
          width: bubbleRect.width,
          height: bubbleRect.height
        },
        floatHtml: bubble?.outerHTML || "",
        viewport: { width: layerRect.width, height: layerRect.height }
      };
      if (bubble) message.classList.add("long-press-source-hidden");
    }
    if (conversation) {
      store.longPress = { role: "conversation", conversationId: Number(conversation.dataset.conversation) };
    }
    if (bookCard) {
      bookCard.classList.add("long-press-active");
      const bookId = bookCard.dataset.go?.split("/").pop();
      store.longPress = { role: "book", bookId: Number(bookId) };
      suppressBookCardClick = true;
    }
    if (annoBlock) {
      const pi = annoBlock.dataset.pi;
      document.querySelectorAll(".anno-block.active").forEach((el) => {
        el.classList.remove("active");
        el.querySelectorAll(".anno-cta, .anno-input").forEach((child) => child.remove());
      });
      annoBlock.classList.add("active");
      if (!annoBlock.querySelector(".anno-input")) {
        const cta = document.createElement("div");
        cta.className = "anno-cta";
        cta.textContent = "让澄也看看 →";
        const inputBox = document.createElement("div");
        inputBox.className = "anno-input";
        inputBox.innerHTML = `<input class="ph" placeholder="写点想法…" data-anno-pi="${pi}"><button class="send" data-action="send-anno" data-pi="${pi}">${icon("send")}</button>`;
        annoBlock.appendChild(cta);
        annoBlock.appendChild(inputBox);
        inputBox.querySelector(".ph").focus();
      }
      store.longPress = { role: "annotation", pi: Number(pi) };
      navigator.vibrate?.(15);
      return;
    }
    const overlay = document.querySelector(".phone-overlay-layer");
    if (overlay) {
      if (conversation && store.drawerOpen) {
        overlay.insertAdjacentHTML("beforeend", renderLongPressMenu());
      } else {
        overlay.innerHTML = renderLongPressMenu();
      }
    }
    navigator.vibrate?.(15);
  }, 500);
});

document.addEventListener("pointermove", (event) => {
  if (!longPressTimer || !longPressStart) return;
  if (Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 12) clearLongPress();
});

["pointerup", "pointercancel"].forEach((eventName) => {
  document.addEventListener(eventName, clearLongPress);
});

document.addEventListener("scroll", updateAutoFollow, true);

document.addEventListener("scroll", () => {
  const body = document.querySelector(".reader-body-v2");
  if (!body || !isReaderPath()) return;
  const pct = body.scrollHeight <= body.clientHeight
    ? 100
    : Math.round((body.scrollTop / (body.scrollHeight - body.clientHeight)) * 100);
  syncReaderProgress(pct);
  clearTimeout(store._progressTimer);
  store._progressTimer = setTimeout(() => {
    const book = store.bookData?.book;
    if (book) api.post(`/api/books/${book.id}/progress`, { scroll_pct: pct }).catch(console.warn);
  }, 3000);
}, true);

document.addEventListener("click", async (event) => {
  if (document.querySelector(".anno-block.active") && !event.target.closest(".anno-block.active, .anno-input, .anno-cta")) {
    document.querySelectorAll(".anno-block.active").forEach((el) => {
      el.classList.remove("active");
      el.querySelectorAll(".anno-cta, .anno-input").forEach((child) => child.remove());
    });
    store.longPress = null;
    return;
  }
  if (store.longPress?.role === "book" && suppressBookCardClick && event.target.closest(".cv2-book")) {
    suppressBookCardClick = false;
    event.preventDefault();
    return;
  }
  if (store.longPress?.role === "book" && !event.target.closest(".long-press-menu") && !event.target.closest(".overlay-scrim")) {
    return dismissLongPress();
  }
  const earlyConversationAction = event.target.closest("[data-conversation-action]")?.dataset.conversationAction;
  if (earlyConversationAction) return handleConversationAction(earlyConversationAction);
  const jumpPi = event.target.closest("[data-jump-pi]");
  if (jumpPi) {
    const pi = Number(jumpPi.dataset.jumpPi);
    const block = document.querySelector(`.anno-block[data-pi="${pi}"]`);
    const body = document.querySelector(".reader-body-v2");
    if (block && body) {
      body.scrollTop += block.getBoundingClientRect().top - body.getBoundingClientRect().top;
      const pct = body.scrollHeight <= body.clientHeight
        ? 100
        : Math.round((body.scrollTop / (body.scrollHeight - body.clientHeight)) * 100);
      syncReaderProgress(pct);
    }
    const overlay = document.querySelector(".phone-overlay-layer");
    if (overlay) overlay.innerHTML = "";
    return;
  }
  const goTarget = event.target.closest("[data-go]");
  if (goTarget) {
    event.preventDefault();
    return go(goTarget.dataset.go);
  }
  const theme = event.target.closest("[data-theme]")?.dataset.theme;
  if (theme) {
    setTheme(theme);
    return render(renderRoute(route()));
  }
  if (store.longPress && store.drawerOpen && event.target.closest(".drawer") && !event.target.closest(".long-press-menu")) {
    store.longPress = null;
    const overlay = document.querySelector(".phone-overlay-layer");
    if (overlay) {
      overlay.querySelectorAll(".long-press-menu, .overlay-scrim").forEach((el) => el.remove());
    }
    return;
  }
  const actionEl = event.target.closest("[data-action]");
  const action = actionEl?.dataset.action;
  const id = Number(event.target.closest("[data-id]")?.dataset.id || 0);
  try {
    if (action === "back") return history.back();
    if (action === "drawer") {
      store.drawerOpen = true;
      return render(renderChat());
    }
    if (action === "plus") {
      store.plusOpen = !store.plusOpen;
      return render(renderChat());
    }
    if (action === "close-plus") {
      store.plusOpen = false;
      return render(renderChat());
    }
    if (action === "close-overlay") {
      if (store.longPress && store.drawerOpen) {
        store.longPress = null;
        clearLongPressActive();
        const overlay = document.querySelector(".phone-overlay-layer");
        if (overlay) overlay.innerHTML = renderDrawer();
        return;
      }
      if (store.longPress) return dismissLongPress();
      store.drawerOpen = false;
      store.plusOpen = false;
      store.longPress = null;
      store.bucketEdit = null;
      store.bucketDetailLoading = false;
      render(renderRoute(route()));
      scheduleReaderInit();
      return;
    }
    if (action === "new-conversation") {
      await createConversation();
      store.drawerOpen = false;
      return render(renderChat());
    }
    if (action === "change-token") {
      clearToken();
      return render(tokenGate("请输入新的访问令牌。"));
    }
    if (action === "open-media-preview") {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) {
        overlay.innerHTML = `<div class="overlay-scrim" data-action="close-media-preview"></div>
          <section class="media-preview">
            <button class="close" data-action="close-media-preview">×</button>
            <button class="media-preview-image" data-action="jump-search-message" data-search-conversation="${esc(actionEl.dataset.searchConversation || "")}" data-search-message="${esc(actionEl.dataset.searchMessage || "")}" aria-label="定位到聊天">
              <img src="${esc(actionEl.dataset.src || "")}" alt="${esc(actionEl.dataset.name || "图片")}">
            </button>
          </section>`;
      }
      return;
    }
    if (action === "jump-search-message") {
      const conversationId = actionEl.dataset.searchConversation;
      const messageId = actionEl.dataset.searchMessage;
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      if (conversationId && messageId) return await scrollToMessage(conversationId, messageId);
      return;
    }
    if (action === "close-media-preview") {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      return;
    }
    if (action === "cancel-inline-edit") {
      store.editingMessageId = null;
      store.editingMessageDraft = "";
      return render(renderChat());
    }
    if (action === "send-inline-edit") {
      const messageId = Number(actionEl.dataset.messageId || 0);
      const target = store.messages.find((item) => Number(item.id) === messageId);
      const input = document.querySelector(`[data-inline-edit="${messageId}"]`);
      const content = String(input?.value || "").trim();
      if (!target) return;
      if (!content) return toast("消息不能为空");
      const index = store.messages.indexOf(target);
      target.content = content;
      store.messages = store.messages.slice(0, index + 1);
      store.editingMessageId = null;
      store.editingMessageDraft = "";
      cacheMessages(store.conversationId, store.messages);
      render(renderChat());
      await sendMessage(content, [], { editMessageId: target.id, index: index + 1 });
      return;
    }
    if (action === "close-dialog") {
      closeAppDialog();
      store.longPress = null;
      clearLongPressActive();
      return;
    }
    if (action === "confirm-quick-todo") {
      const content = String(document.querySelector("#journal-quick-input")?.value || "").trim();
      if (!content) return toast("待办不能为空");
      await api.post("/api/todos", { content, due_date: store.calendarSelectedDate });
      await loadCalendar(true);
      await loadHome(true);
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      render(renderCalendar());
      return;
    }
    if (action === "confirm-quick-milestone") {
      const title = String(document.querySelector("#journal-quick-input")?.value || "").trim();
      if (!title) return toast("里程碑不能为空");
      await api.post("/api/milestones", { title, date: store.calendarSelectedDate });
      await loadCalendar(true);
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      render(renderCalendar());
      return;
    }
    if (action === "confirm-conversation-rename") {
      const conversationId = Number(actionEl.dataset.conversationId || 0);
      const title = String(document.querySelector("#conversation-rename-input")?.value || "").trim();
      if (!conversationId || !title) return;
      await api.patch(`/api/conversations/${conversationId}`, { title });
      await loadConversations(true);
      closeAppDialog();
      refreshDrawerDom();
      store.longPress = null;
      toast("已重命名");
      return;
    }
    if (action === "confirm-conversation-delete") {
      const conversationId = Number(actionEl.dataset.conversationId || 0);
      if (!conversationId) return;
      await api.delete(`/api/conversations/${conversationId}`);
      const remaining = store.conversations.filter((entry) => entry.id !== conversationId);
      saveConversationsCache(remaining);
      delete store.messageCache[conversationId];
      delete store.cacheAt.messages[conversationId];
      if (store.conversationId === conversationId) rememberConversation(remaining[0]?.id || null);
      await loadConversations(true);
      await loadMessages(true);
      store.longPress = null;
      store.drawerOpen = true;
      clearLongPressActive();
      closeAppDialog();
      refreshDrawerDom();
      toast("已删除");
      return;
    }
    if (action === "search-media") {
      const kind = actionEl?.dataset.kind;
      if (!["image", "file"].includes(kind)) return;
      store.searchMode = kind;
      store.searchMedia = await api.get(`/api/search?type=${kind}`);
      return render(renderSearchPage());
    }
    if (action === "search-date-mode") {
      store.searchMode = "date";
      await loadSearchCalendarTimeline();
      return render(renderSearchPage());
    }
    if (action === "refresh-models") {
      const form = actionEl.closest("[data-preset-form]");
      if (!form) return;
      const key = actionEl.dataset.keyId || "new";
      const draft = rememberPresetDraft(form);
      store.modelLoading = key;
      store.modelOptionErrors[key] = "";
      render(renderApiSettings());
      try {
        const data = await api.post("/api/models/list", {
          endpoint: draft.endpoint,
          api_key: draft.api_key,
          format: draft.format
        });
        store.modelOptions[key] = data.models || [];
        store.modelManualModels[key] = !store.modelOptions[key].length;
        if (!store.modelOptions[key].length) store.modelOptionErrors[key] = "没有拿到可用模型，请手动输入。";
      } catch (error) {
        store.modelOptions[key] = [];
        store.modelManualModels[key] = true;
        store.modelOptionErrors[key] = error.message;
        toast(error.message);
      } finally {
        store.modelLoading = null;
      }
      return render(renderApiSettings());
    }
    if (action === "toggle-model-manual") {
      const form = actionEl.closest("[data-preset-form]");
      if (form) rememberPresetDraft(form);
      const key = actionEl.dataset.keyId || "new";
      store.modelManualModels[key] = !store.modelManualModels[key];
      return render(renderApiSettings());
    }
    if (action === "open-model-picker") {
      const form = actionEl.closest("[data-preset-form]");
      if (form) rememberPresetDraft(form);
      store.modelPicker = { key: actionEl.dataset.keyId || "new" };
      store.modelFilter = "";
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = renderModelPicker();
      return;
    }
    if (action === "close-model-picker") {
      store.modelPicker = null;
      store.modelFilter = "";
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      return;
    }
    if (action === "choose-model") {
      const key = actionEl.dataset.keyId || "new";
      const modelId = actionEl.dataset.modelId || "";
      if (key === "new") {
        store.newPresetDraft = { ...(store.newPresetDraft || {}), model: modelId };
      } else {
        const preset = store.presets.find((item) => String(item.id) === key);
        if (preset) preset.model = modelId;
      }
      store.modelPicker = null;
      store.modelFilter = "";
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      return render(renderApiSettings());
    }
    if (action === "exec-command") {
      const input = document.querySelector("#term-cmd-input");
      const command = String(input?.value || "").trim();
      if (!command) return;
      const result = await api.post("/api/terminal/exec", { command });
      store.terminalHistory.unshift(result);
      store.terminalHistory = store.terminalHistory.slice(0, 50);
      return render(renderTerminal());
    }
    if (action === "show-export-confirm") {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) {
        overlay.innerHTML = `<div class="overlay-scrim" data-action="cancel-export"></div>
          <section class="confirm-dialog">
            <div class="confirm-text">确认导出所有聊天记录和伴读内容？</div>
            <div class="confirm-actions">
              <button class="cancel" data-action="cancel-export">取消</button>
              <button class="ok" data-action="confirm-export">确认</button>
            </div>
          </section>`;
      }
      return;
    }
    if (action === "cancel-export") {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      return;
    }
    if (action === "confirm-export") {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      await api.downloadExport({
        scope: "all",
        content_types: ["chat", "annotations"],
        date_range: "all",
        format: "md"
      });
      toast("导出已开始");
      return;
    }
    if (action === "send-anno") {
      const pi = Number(actionEl?.dataset.pi);
      const input = document.querySelector(`.ph[data-anno-pi="${pi}"]`);
      const content = input?.value?.trim();
      if (!content) return;
      const book = store.bookData?.book;
      if (!book) return;
      const progress = currentReaderProgress();
      await api.post(`/api/books/${book.id}/annotations`, { paragraph_index: pi, content, role: "user" });
      store.bookData = await api.get(`/api/books/${book.id}/all`);
      store.longPress = null;
      renderReaderKeepingProgress(progress);
      return;
    }
    if (action === "toggle-thought") {
      const row = event.target.closest(".msg-row");
      const messageId = Number(row?.dataset.messageId || 0);
      const streamKey = row?.dataset.streamKey;
      const messageIndex = Number(row?.dataset.messageIndex ?? -1);
      const message = store.messages.find((item) =>
        (messageId && Number(item.id) === messageId) ||
        (streamKey && item.streamKey === streamKey)
      ) || store.messages[messageIndex];
      if (message) {
        if (message.thinkingStarted) return;
        message.thinkingOpen = !message.thinkingOpen;
        updateThoughtDom(row, message);
        return;
      }
    }
    if (action === "prev-month" || action === "next-month") {
      const [year, month] = store.calendarMonth.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1 + (action === "next-month" ? 1 : -1), 1));
      store.calendarMonth = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
      store.calendarSelectedDate = today.startsWith(store.calendarMonth) ? today : `${store.calendarMonth}-01`;
      await loadCalendar(true);
      return render(renderCalendar());
    }
    if (action === "checkin") {
      await api.post("/api/checkins", {});
      await loadCalendar(true);
      await loadHome(true);
      return render(renderCalendar());
    }
    if (action === "quick-todo") {
      showJournalInputDialog("todo");
      return;
    }
    if (action === "quick-milestone") {
      showJournalInputDialog("milestone");
      return;
    }
    if (action === "discuss-book") {
      const excerpt = (store.bookData?.paragraphs || []).map((item) => item.content).join("\n").slice(0, 180);
      go("/chat");
      setTimeout(() => sendMessage(`我们聊聊我刚读到的这一段：${excerpt}`, []), 450);
    }
    if (action === "show-toc") {
      const data = store.bookData;
      if (!data) return;
      const paragraphs = data.paragraphs || [];
      const tocItems = paragraphs.filter((item) => {
        const content = item.content.trim();
        return /^第[一二三四五六七八九十百千\d]+[章节回卷]/.test(content) ||
          /^Chapter\s+\d/i.test(content) ||
          /^序[章言]|^楔子|^尾声|^番外/.test(content);
      });
      if (!tocItems.length) {
        toast("未找到章节目录");
        return;
      }
      const list = tocItems.map((item) =>
        `<div class="toc-item" data-jump-pi="${item.paragraph_index}">${esc(item.content.trim().slice(0, 30))}</div>`
      ).join("");
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) {
        overlay.innerHTML = `<div class="overlay-scrim" data-action="close-overlay"></div>
      <section class="anno-list-panel">
        <div class="anno-list-title">目录</div>
        <div class="toc-list jnl-scroll">${list}</div>
      </section>`;
      }
      return;
    }
    if (action === "show-annotations") {
      const data = store.bookData;
      if (!data) return;
      const annotations = data.annotations || [];
      if (!annotations.length) {
        toast("还没有批注");
        return;
      }
      const userAnnotations = annotations.filter((item) => item.role === "user");
      if (!userAnnotations.length) {
        toast("还没有批注");
        return;
      }
      const list = userAnnotations.map((item) =>
        `<div class="anno-list-item" data-jump-pi="${item.paragraph_index}"><div class="anno-list-content">${esc(item.content)}</div></div>`
      ).join("");
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) {
        overlay.innerHTML = `<div class="overlay-scrim" data-action="close-overlay"></div><section class="anno-list-panel"><div class="anno-list-title">我的批注</div>${list}</section>`;
      }
      return;
    }
    if (action === "chat-about-book") {
      toast("共读聊天开发中");
      return;
    }
    const annoCta = event.target.closest(".anno-cta");
    if (annoCta) {
      const annoBlock = event.target.closest(".anno-block");
      const pi = Number(annoBlock?.dataset.pi);
      const book = store.bookData?.book;
      if (!book || Number.isNaN(pi)) return;
      annoCta.textContent = "澄在想…";
      annoCta.style.pointerEvents = "none";
      try {
        const progress = currentReaderProgress();
        await api.post(`/api/books/${book.id}/annotations/${pi}/ai-reply`, {});
        store.bookData = await api.get(`/api/books/${book.id}/all`);
        store.longPress = null;
        renderReaderKeepingProgress(progress);
      } catch (err) {
        toast(err.message);
        annoCta.textContent = "让澄也看看 →";
        annoCta.style.pointerEvents = "";
      }
      return;
    }
    if (action === "toggle-preset") {
      store.expandedPresetId = store.expandedPresetId === id ? null : id;
      store.addingPreset = false;
      return render(renderApiSettings());
    }
    if (action === "add-preset") {
      store.addingPreset = true;
      store.expandedPresetId = null;
      store.newPresetDraft = null;
      return render(renderApiSettings());
    }
    if (action === "toggle-preset-key") {
      const key = event.target.closest("[data-key-id]").dataset.keyId;
      const form = event.target.closest("[data-preset-form]");
      if (form) rememberPresetDraft(form);
      store.visiblePresetKeys[key] = !store.visiblePresetKeys[key];
      return render(renderApiSettings());
    }
    if (action === "toggle-mcp") {
      store.expandedMcpId = store.expandedMcpId === id ? null : id;
      store.addingMcp = false;
      return render(renderMcpSettings());
    }
    if (action === "add-mcp") {
      store.addingMcp = true;
      store.expandedMcpId = null;
      return render(renderMcpSettings());
    }
    if (action === "toggle-mcp-enabled") {
      const server = store.mcpServers.find((item) => item.id === id);
      await api.patch(`/api/mcp_servers/${id}`, { enabled: !server?.enabled });
      await loadSettings(true);
      return render(renderMcpSettings());
    }
    if (action === "delete-mcp" && confirm("删除这个 MCP 服务？")) {
      await api.delete(`/api/mcp_servers/${id}`);
      await loadSettings(true);
      return render(renderMcpSettings());
    }
  } catch (error) {
    toast(error.message);
  }

  const conversationId = event.target.closest("[data-conversation]")?.dataset.conversation;
  if (conversationId) {
    rememberConversation(conversationId);
    store.drawerOpen = false;
    await loadMessages(true);
    return render(renderChat());
  }
  const calendarDate = event.target.closest("[data-calendar-date]")?.dataset.calendarDate;
  if (calendarDate) {
    store.calendarSelectedDate = calendarDate;
    return render(renderCalendar());
  }
  const searchConversationId = event.target.closest("[data-search-conversation]")?.dataset.searchConversation;
  const searchMessageId = event.target.closest("[data-search-message]")?.dataset.searchMessage;
  if (searchConversationId && searchMessageId) {
    try {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      return await scrollToMessage(searchConversationId, searchMessageId);
    } catch (error) {
      return toast(error.message);
    }
  }
  const searchGroupId = event.target.closest("[data-search-group]")?.dataset.searchGroup;
  if (searchGroupId) {
    try {
      store.searchDetail = await api.get(`/api/search?type=keyword_detail&q=${encodeURIComponent(store.searchQuery)}&conversation_id=${encodeURIComponent(searchGroupId)}`);
      const group = store.searchGroups.find((item) => Number(item.conversation_id) === Number(searchGroupId));
      store.searchConversationTitle = group?.conversation_title || "聊天记录";
      store.searchMode = "keyword-detail";
      return render(renderSearchPage());
    } catch (error) {
      return toast(error.message);
    }
  }
  const searchDay = event.target.closest("[data-search-day]")?.dataset.searchDay;
  if (searchDay) {
    try {
      const groups = await api.get(`/api/search?type=date&date=${encodeURIComponent(searchDay)}`);
      if (!groups.length) return toast("这一天没有聊天记录");
      if (groups.length === 1) return await scrollToMessage(groups[0].conversation_id, groups[0].message_id);
      store.searchDateGroups = groups;
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) {
        overlay.innerHTML = `<div class="overlay-scrim" data-action="close-overlay"></div>
          <section class="search-choice-panel">
            <div class="title">选择对话</div>
            ${groups.map((item) => `<button data-date-conversation="${item.conversation_id}" data-message-id="${item.message_id}">
              <span>${esc(item.conversation_title || "新对话")}</span><em>${item.count} 条</em>
            </button>`).join("")}
          </section>`;
      }
      return;
    } catch (error) {
      return toast(error.message);
    }
  }
  const dateConversation = event.target.closest("[data-date-conversation]");
  if (dateConversation) {
    try {
      const overlay = document.querySelector(".phone-overlay-layer");
      if (overlay) overlay.innerHTML = "";
      return await scrollToMessage(dateConversation.dataset.dateConversation, dateConversation.dataset.messageId);
    } catch (error) {
      return toast(error.message);
    }
  }
  const domain = event.target.closest("[data-domain]")?.dataset.domain;
  if (domain) {
    store.memoryDomain = domain;
    return render(renderMemory("bucket"));
  }
  const bucket = event.target.closest("[data-bucket-edit]")?.dataset.bucketEdit;
  if (bucket) {
    store.bucketEdit = bucket;
    loadMemoryBucketDetail(bucket).catch(console.warn);
    return;
  }
  const archive = event.target.closest("[data-archive-id]")?.dataset.archiveId;
  if (archive) {
    store.archiveOpen = store.archiveOpen === archive ? null : archive;
    return render(renderMemory("archive"));
  }
  const todo = event.target.closest("[data-todo]")?.dataset.todo;
  if (todo) {
    const item = store.calendar?.todos?.find((entry) => entry.id === Number(todo));
    await api.patch(`/api/todos/${todo}`, { done: !item?.done });
    await loadCalendar(true);
    await loadHome(true);
    return render(renderCalendar());
  }
  const messageAction = event.target.closest("[data-message-action]")?.dataset.messageAction;
  if (messageAction) return handleMessageAction(messageAction);
  const conversationAction = event.target.closest("[data-conversation-action]")?.dataset.conversationAction;
  if (conversationAction) return handleConversationAction(conversationAction);
  const bookAction = event.target.closest("[data-book-action]")?.dataset.bookAction;
  if (bookAction) {
    const bookId = store.longPress?.bookId;
    if (!bookId) return dismissLongPress();
    if (bookAction === "rename") {
      const book = (store.books || []).find((item) => item.id === bookId);
      const title = prompt("重命名", book?.title || "");
      if (title?.trim()) {
        await api.patch(`/api/books/${bookId}`, { title: title.trim() });
        await loadBooks(true);
      }
    }
    if (bookAction === "delete" && confirm("删除这本书？")) {
      await api.delete(`/api/books/${bookId}`);
      await loadBooks(true);
    }
    dismissLongPress();
    render(renderShelf());
    return;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#composer textarea")) {
    store.chatDraft = event.target.value;
    event.target.style.height = "40px";
    event.target.style.height = `${Math.min(112, event.target.scrollHeight)}px`;
    const send = document.querySelector(".send");
    if (send) send.disabled = !store.chatDraft.trim() && !store.pendingAttachments.length;
  }
  if (event.target.matches("[data-inline-edit]")) {
    store.editingMessageDraft = event.target.value;
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`;
  }
  if (event.target.matches("#memory-search")) {
    store.memoryQuery = event.target.value;
    render(renderMemory(route() === "/memory/archive" ? "archive" : "bucket"));
  }
  if (event.target.matches("#model-filter")) {
    store.modelFilter = event.target.value;
    const overlay = document.querySelector(".phone-overlay-layer");
    if (overlay) overlay.innerHTML = renderModelPicker();
    requestAnimationFrame(() => {
      const input = document.querySelector("#model-filter");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }
});

document.addEventListener("change", async (event) => {
  try {
    if (event.target.matches("[data-upload-file]") && event.target.files[0]) {
      const uploaded = await api.upload(event.target.files[0]);
      store.pendingAttachments.push(uploaded);
      store.plusOpen = false;
      render(renderChat());
      toast(`${uploaded.name} 已添加`);
    }
    if (event.target.matches("[data-upload-book]") && event.target.files[0]) {
      await api.uploadBook(event.target.files[0], event.target.files[0].name.replace(/\.txt$/i, ""));
      await loadBooks(true);
      render(renderShelf());
      toast("书已放进书架");
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = formValue(form);
  try {
    if (form.id === "token-form") return verifyToken(data.token);
    if (form.id === "composer") {
      const content = String(data.content || "").trim();
      const attachments = [...store.pendingAttachments];
      if (!content && !attachments.length) return;
      store.chatDraft = "";
      store.pendingAttachments = [];
      const fallback = attachments.length ? `发送了 ${attachments.length} 个附件。` : "";
      return sendMessage(content || fallback, attachments);
    }
    if (form.id === "prompt-form") {
      await api.patch("/api/settings", data);
      await loadSettings(true);
      toast("已保存");
    }
    if (form.matches("[data-preset-form]")) {
      const presetId = Number(form.dataset.id || 0);
      const body = { ...data };
      if (event.submitter?.dataset.activate) body.active = true;
      if (presetId) await api.patch(`/api/presets/${presetId}`, body);
      else await api.post("/api/presets", body);
      store.addingPreset = false;
      store.newPresetDraft = null;
      await loadSettings(true);
      render(renderApiSettings());
      toast(body.active ? "API 预设已启用" : "API 预设已保存");
    }
    if (form.matches("[data-mcp-form]")) {
      const serverId = Number(form.dataset.id || 0);
      if (serverId) await api.patch(`/api/mcp_servers/${serverId}`, data);
      else await api.post("/api/mcp_servers", data);
      store.addingMcp = false;
      await loadSettings(true);
      render(renderMcpSettings());
      toast("MCP 服务已保存");
    }
    if (form.id === "anniv-form") {
      await api.post("/api/anniversaries", data);
      await loadSettings(true);
      render(renderAnniversaries());
      toast("纪念日已添加");
    }
    if (form.id === "chat-search-form") {
      store.searchQuery = String(data.q || "").trim();
      if (!store.searchQuery) {
        store.searchMode = "home";
        store.searchGroups = [];
        return render(renderSearchPage());
      }
      store.searchGroups = await api.get(`/api/search?type=keyword&q=${encodeURIComponent(store.searchQuery)}`);
      store.searchMode = "keyword-groups";
      render(renderSearchPage());
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("click", (event) => {
  const pick = event.target.closest("[data-format-pick]");
  if (!pick) return;
  const form = pick.closest("form");
  form.querySelector('input[name="format"]').value = pick.dataset.formatPick;
  form.querySelectorAll(".pick").forEach((node) => node.classList.toggle("active", node === pick));
  if (form.matches("[data-preset-form]")) {
    const key = form.dataset.id || "new";
    store.modelOptions[key] = [];
    store.modelManualModels[key] = true;
    store.modelOptionErrors[key] = "";
    rememberPresetDraft(form);
    render(renderApiSettings());
  }
});

document.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".msg-row, .drawer-item, .cv2-book, .anno-block")) event.preventDefault();
});

async function handleMessageAction(action) {
  const target = store.messages.find((item) => item.id === store.longPress?.id) || store.messages[store.longPress?.index];
  if (!target) return;
  if (action === "copy") {
    await navigator.clipboard.writeText(target.content || "");
    toast("已复制");
    return dismissLongPress();
  }
  if (!target.id) {
    toast("消息保存后才能操作");
    return dismissLongPress();
  }
  if (action === "star") {
    await api.patch(`/api/messages/${target.id}`, { starred: !target.starred });
    target.starred = !target.starred;
    toast(target.starred ? "已星标" : "已取消星标");
    return dismissLongPress();
  }
  if (action === "edit") {
    store.editingMessageId = target.id;
    store.editingMessageDraft = target.content || "";
    store.longPress = null;
    dismissLongPress();
    render(renderChat());
    requestAnimationFrame(() => {
      const input = document.querySelector(`[data-inline-edit="${target.id}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.style.height = "auto";
        input.style.height = `${Math.min(160, input.scrollHeight)}px`;
      }
    });
    return;
  }
  if (action === "delete") {
    await api.delete(`/api/messages/${target.id}`);
    store.messages = store.messages.filter((item) => item.id !== target.id);
    cacheMessages(store.conversationId, store.messages);
  }
  if (action === "regenerate") {
    const index = store.messages.indexOf(target);
    const messageId = target.id;
    store.messages = store.messages.slice(0, index);
    cacheMessages(store.conversationId, store.messages);
    store.longPress = null;
    render(renderChat());
    await sendMessage("", [], { messageId, index });
    return;
  }
  store.longPress = null;
  render(renderChat());
}

async function handleConversationAction(action) {
  const id = store.longPress?.conversationId;
  const item = store.conversations.find((entry) => entry.id === id);
  if (!item) return;
  if (action === "rename") {
    removeLongPressMenuDom();
    store.longPress = null;
    clearLongPressActive();
    showConversationRenameDialog(item);
    return;
  }
  if (action === "delete") {
    removeLongPressMenuDom();
    store.longPress = null;
    clearLongPressActive();
    showConversationDeleteDialog(item);
    return;
  }
  store.longPress = null;
  await loadConversations(true);
  await loadMessages(true);
  render(renderChat());
}

window.addEventListener("hashchange", navigate);
window.addEventListener("cheng:unauthorized", () => render(tokenGate("令牌已失效，请重新输入。")));

window.__setContextPct = (value) => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return store.contextPct;
  store.contextPct = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
  if (route() === "/chat") render(renderChat());
  return store.contextPct;
};

updateThemeMeta();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`/sw.js?v=${VERSION}`).catch(console.warn);
}

document.addEventListener("touchmove", (event) => {
  if (!event.target.closest(".scroll, .chat-stream, .drawer-list, .es-body, .home-page, .jnl-scroll, .book-list, .reader-body, .model-list")) {
    event.preventDefault();
  }
}, { passive: false });

document.addEventListener("touchstart", (event) => {
  const bar = event.target.closest(".pbar-touch");
  if (!bar) return;
  store._dragging = true;
  handleProgressDrag(event, bar);
}, { passive: true });

document.addEventListener("touchmove", (event) => {
  if (!store._dragging) return;
  const bar = document.querySelector(".pbar-touch");
  if (bar) handleProgressDrag(event, bar);
}, { passive: true });

document.addEventListener("touchend", async (event) => {
  if (!store._dragging) return;
  store._dragging = false;
  const book = store.bookData?.book;
  const pct = parseFloat(document.querySelector(".reader-pct")?.textContent) || 0;
  if (book) api.post(`/api/books/${book.id}/progress`, { scroll_pct: pct }).catch(console.warn);
});

navigate();
