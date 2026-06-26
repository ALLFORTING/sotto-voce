import { api, streamChat } from "./api.js";
import {
  errorPage,
  esc,
  formValue,
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
  rememberConversation,
  saveArchiveCache,
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
  scrollChat,
  updateAutoFollow,
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
  renderSettings
} from "./settings.js";

const app = document.querySelector("#app");
let navigationId = 0;
let longPressTimer = 0;
let longPressStart = null;

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
  requestAnimationFrame(() => scrollChat());
}

async function loadHome(force = false) {
  if (!force && store.home && cacheFresh("home", CACHE_MS.home)) return;
  store.home = await api.get("/api/home");
  store.cacheAt.home = Date.now();
}

async function loadConversations(force = false) {
  if (!force && store.conversations.length && cacheFresh("conversations", CACHE_MS.conversations)) return;
  store.conversations = await api.get("/api/conversations");
  store.cacheAt.conversations = Date.now();
  if (store.conversationId && !store.conversations.some((item) => item.id === store.conversationId)) {
    rememberConversation(store.conversations[0]?.id || null);
  }
  if (!store.conversationId && store.conversations.length) rememberConversation(store.conversations[0].id);
}

async function loadMessages(force = false) {
  if (!store.conversationId) {
    store.messages = [];
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
  store.currentBook = await api.get(`/api/books/${id}`);
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
  await refreshMemoryBuckets();
}

function hasWarmRouteCache(path) {
  if (path === "/") return Boolean(store.home);
  if (path === "/journal" || path === "/chat/search") return true;
  if (path === "/chat") return Boolean(store.cacheAt.conversations || store.messages.length || store.conversationId);
  if (path === "/journal/calendar") return Boolean(store.calendar);
  if (path === "/journal/books") return Boolean(store.cacheAt.books || store.books.length);
  if (path.startsWith("/journal/books/")) return Boolean(store.currentBook);
  if (path === "/journal/ledger") return Boolean(store.usageSummary && store.usageDetail);
  if (path === "/memory") return store.memories.length > 0;
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

async function createConversation() {
  const item = await api.post("/api/conversations", {});
  rememberConversation(item.id);
  store.conversations.unshift(item);
  store.messages = [];
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
  if (path === "/settings/anniv") return renderAnniversaries();
  if (path === "/chat/search") return renderSearchPage();
  return renderHome();
}

function renderSearchPage(results = []) {
  const rows = results.map((item) => `<button class="search-result" data-search-conversation="${item.conversation_id}">
    <span class="top"><span class="who">${item.role === "assistant" ? "澄" : "我"}</span><span>${esc(item.created_at?.slice(0, 10) || "")}</span></span>
    <span class="body">${esc(String(item.content || "").slice(0, 120))}</span>
  </button>`).join("");
  const body = `<main class="page">
    ${subpageTop("搜索聊天")}
    <form id="chat-search-form" class="search-bar"><input name="q" value="陀思妥耶夫斯基" placeholder="搜索聊天"></form>
    <div class="filter-row"><button class="chip">文件</button><button class="chip">图片</button></div>
    <section class="scroll" id="search-results">${rows || '<div class="loading-text">输入关键词后回车搜索。</div>'}</section>
  </main>`;
  return phone({ activeTab: "chat", hideTab: true, body });
}

async function navigate() {
  const id = ++navigationId;
  const path = route();
  store.route = path;
  updateThemeMeta();
  if (!store.token) {
    render(tokenGate());
    return;
  }
  if (path === "/memory/archive" && !store.archives.length) store.archiveLoading = true;
  if (hasWarmRouteCache(path)) render(renderRoute(path));
  else render(loadingPage());
  try {
    await prepare(path);
    if (id !== navigationId || path !== route()) return;
    render(renderRoute(path));
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
  if (!regenerating && !store.conversationId) await createConversation();
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
  if (regenerating) {
    store.messages.splice(options.index, 0, assistant);
  } else {
    store.messages.push({
      role: "user",
      content,
      attachments,
      created_at: new Date().toISOString()
    }, assistant);
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
    thinkingEnded: false,
    collapseThought: false
  };
  const finalize = async () => {
    if (
      pending.text ||
      pending.thinking ||
      pending.collapseThought ||
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
  };
  const drain = () => {
    pending.frame = 0;
    if (pending.thinking) {
      const take = Math.max(1, Math.ceil(pending.thinking.length / 90));
      assistant.thinking += pending.thinking.slice(0, take);
      pending.thinking = pending.thinking.slice(take);
      updateStreamMeta(assistant);
    }
    if (!pending.thinking && pending.collapseThought) {
      pending.collapseThought = false;
      assistant.thinkingOpen = false;
      updateStreamMeta(assistant);
    }
    const canRenderText = !pending.sawThinking || (pending.thinkingEnded && !pending.thinking && !pending.collapseThought);
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
    if (pending.thinking || pending.collapseThought || (pending.text && canRenderText)) pending.frame = requestAnimationFrame(drain);
    else finalize().catch(console.warn);
  };
  const schedule = () => {
    if (!pending.frame) pending.frame = requestAnimationFrame(drain);
  };
  try {
    await streamChat(
      regenerating ? { message_id: options.messageId } : { conversation_id: store.conversationId, content, attachments },
      (event, data) => {
        if (event === "thinking_start") {
          pending.sawThinking = true;
          pending.thinkingEnded = false;
          pending.collapseThought = false;
          assistant.thinkingStarted = true;
          assistant.thinkingOpen = true;
          updateStreamMeta(assistant);
        }
        if (event === "thinking_delta" && data.text) {
          pending.sawThinking = true;
          if (!pending.thinkingEnded) assistant.thinkingStarted = true;
          assistant.thinkingOpen = true;
          pending.thinking += data.text;
          schedule();
        }
        if (event === "thinking_end") {
          pending.sawThinking = true;
          pending.thinkingEnded = true;
          pending.collapseThought = true;
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
      regenerating ? "/api/chat/regenerate" : "/api/chat"
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
  document.querySelector(".long-press-active")?.classList.remove("long-press-active");
}

document.addEventListener("pointerdown", (event) => {
  const message = event.target.closest(".msg-row[data-message-id]");
  const conversation = event.target.closest(".drawer-item");
  if (!message && !conversation) return;
  clearLongPress();
  longPressStart = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => {
    if (message) {
      message.classList.add("long-press-active");
      const rect = message.getBoundingClientRect();
      const id = Number(message.dataset.messageId);
      const target = store.messages.find((item) => item.id === id);
      store.longPress = {
        id,
        role: message.dataset.role,
        starred: Boolean(target?.starred),
        rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
      };
    }
    if (conversation) {
      store.longPress = { role: "conversation", conversationId: Number(conversation.dataset.conversation) };
    }
    render(renderRoute(route()));
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

document.addEventListener("click", async (event) => {
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
  const action = event.target.closest("[data-action]")?.dataset.action;
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
      store.drawerOpen = false;
      store.plusOpen = false;
      store.longPress = null;
      store.bucketEdit = null;
      return render(renderRoute(route()));
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
    if (action === "toggle-thought") {
      const row = event.target.closest(".msg-row");
      const messageId = Number(row?.dataset.messageId || 0);
      const streamKey = row?.dataset.streamKey;
      const message = store.messages.find((item) => item.id === messageId || item.streamKey === streamKey);
      if (message) {
        if (message.thinkingStarted) return;
        message.thinkingOpen = !message.thinkingOpen;
        return render(renderChat());
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
      const content = prompt("新增待办");
      if (content?.trim()) {
        await api.post("/api/todos", { content: content.trim(), due_date: store.calendarSelectedDate });
        await loadCalendar(true);
        render(renderCalendar());
      }
    }
    if (action === "quick-milestone") {
      const title = prompt("新增里程碑");
      if (title?.trim()) {
        await api.post("/api/milestones", { title: title.trim(), date: store.calendarSelectedDate });
        await loadCalendar(true);
        render(renderCalendar());
      }
    }
    if (action === "discuss-book") {
      const excerpt = store.currentBook?.chapter?.content?.slice(0, 180) || "";
      go("/chat");
      setTimeout(() => sendMessage(`我们聊聊我刚读到的这一段：${excerpt}`, []), 450);
    }
    if (action === "toggle-preset") {
      store.expandedPresetId = store.expandedPresetId === id ? null : id;
      store.addingPreset = false;
      return render(renderApiSettings());
    }
    if (action === "add-preset") {
      store.addingPreset = true;
      store.expandedPresetId = null;
      return render(renderApiSettings());
    }
    if (action === "toggle-preset-key") {
      const key = event.target.closest("[data-key-id]").dataset.keyId;
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
  if (searchConversationId) {
    rememberConversation(searchConversationId);
    return go("/chat");
  }
  const domain = event.target.closest("[data-domain]")?.dataset.domain;
  if (domain) {
    store.memoryDomain = domain;
    return render(renderMemory("bucket"));
  }
  const bucket = event.target.closest("[data-bucket-edit]")?.dataset.bucketEdit;
  if (bucket) {
    store.bucketEdit = bucket;
    return render(renderMemory("bucket"));
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
    return render(renderCalendar());
  }
  const messageAction = event.target.closest("[data-message-action]")?.dataset.messageAction;
  if (messageAction) return handleMessageAction(messageAction);
  const conversationAction = event.target.closest("[data-conversation-action]")?.dataset.conversationAction;
  if (conversationAction) return handleConversationAction(conversationAction);
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#composer textarea")) {
    store.chatDraft = event.target.value;
    event.target.style.height = "40px";
    event.target.style.height = `${Math.min(112, event.target.scrollHeight)}px`;
    const send = document.querySelector(".send");
    if (send) send.disabled = !store.chatDraft.trim() && !store.pendingAttachments.length;
  }
  if (event.target.matches("#memory-search")) {
    store.memoryQuery = event.target.value;
    render(renderMemory(route() === "/memory/archive" ? "archive" : "bucket"));
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
      const body = { ...data, active: Boolean(event.submitter?.dataset.activate) };
      if (presetId) await api.patch(`/api/presets/${presetId}`, body);
      else await api.post("/api/presets", body);
      store.addingPreset = false;
      await loadSettings(true);
      render(renderApiSettings());
      toast("API 预设已保存");
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
      const results = await api.get(`/api/search?q=${encodeURIComponent(data.q)}&type=all`);
      render(renderSearchPage(results));
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
});

async function handleMessageAction(action) {
  const target = store.messages.find((item) => item.id === store.longPress?.id);
  if (!target) return;
  if (action === "copy") {
    await navigator.clipboard.writeText(target.content || "");
    toast("已复制");
  }
  if (action === "star") {
    await api.patch(`/api/messages/${target.id}`, { starred: !target.starred });
    target.starred = !target.starred;
    toast(target.starred ? "已星标" : "已取消星标");
  }
  if (action === "edit") {
    const content = prompt("编辑消息", target.content);
    if (content?.trim()) {
      await api.patch(`/api/messages/${target.id}`, { content: content.trim() });
      target.content = content.trim();
    }
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
    const title = prompt("重命名会话", item.title);
    if (title?.trim()) await api.patch(`/api/conversations/${id}`, { title: title.trim() });
  }
  if (action === "delete" && confirm("删除这个会话？")) {
    await api.delete(`/api/conversations/${id}`);
    if (store.conversationId === id) rememberConversation(null);
  }
  store.longPress = null;
  await loadConversations(true);
  await loadMessages(true);
  render(renderChat());
}

window.addEventListener("hashchange", navigate);
window.addEventListener("cheng:unauthorized", () => render(tokenGate("令牌已失效，请重新输入。")));

updateThemeMeta();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`/sw.js?v=${VERSION}`).catch(console.warn);
}
navigate();
