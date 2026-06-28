export const VERSION = "20260627-b3";

const readJson = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

export const themes = ["light", "dark", "frost", "pearl", "academy", "gothic"];
const savedTheme = localStorage.getItem("cheng_theme_v2") || localStorage.getItem("cheng_theme") || "light";
const todayChina = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
const thisMonthChina = () => todayChina().slice(0, 7);

export const store = {
  token: localStorage.getItem("cheng_api_token") || "",
  theme: themes.includes(savedTheme) ? savedTheme : "light",
  route: location.hash.slice(1) || "/",
  home: readJson("cheng_home_v2", null),
  conversations: readJson("cheng_conversations_v2", []),
  conversationId: Number(localStorage.getItem("cheng_conversation_id") || 0) || null,
  messages: [],
  messageCache: {},
  chatDraft: "",
  pendingAttachments: [],
  contextPct: 0.02,
  calendarMonth: thisMonthChina(),
  calendarSelectedDate: todayChina(),
  calendar: null,
  todos: [],
  milestones: [],
  books: [],
  currentBook: null,
  currentPage: null,
  usageSummary: null,
  usageDetail: null,
  memories: readJson("cheng_memory_buckets_v2", []),
  archives: readJson("cheng_memory_archives_v2", []),
  trend: readJson("cheng_memory_trend_v2", []),
  archiveLoading: false,
  memoryMode: "bucket",
  memoryQuery: "",
  memoryDomain: "全部",
  settings: {},
  presets: [],
  mcpServers: [],
  anniversaries: [],
  terminalHistory: [],
  cacheAt: {
    home: Number(localStorage.getItem("cheng_home_v2_at") || 0),
    conversations: Number(localStorage.getItem("cheng_conversations_v2_at") || 0),
    messages: {},
    calendar: 0,
    books: 0,
    usage: 0,
    memories: Number(localStorage.getItem("cheng_memory_buckets_v2_at") || 0),
    archives: Number(localStorage.getItem("cheng_memory_archives_v2_at") || 0),
    settings: 0
  },
  drawerOpen: false,
  plusOpen: false,
  longPress: null,
  archiveOpen: null,
  editingMessageId: null,
  expandedPresetId: null,
  expandedMcpId: null,
  addingPreset: false,
  addingMcp: false,
  visiblePresetKeys: {},
  bucketEdit: null,
  loading: false,
  error: ""
};

export function resolvedTheme() {
  const value = themes.includes(store.theme) ? store.theme : "light";
  return value;
}

export function setTheme(theme) {
  store.theme = themes.includes(theme) ? theme : "light";
  localStorage.setItem("cheng_theme_v2", store.theme);
  updateThemeMeta();
}

export function updateThemeMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.content = ["dark", "academy", "gothic"].includes(resolvedTheme())
    ? "#2A2421"
    : "#FBF8F3";
}

export function setToken(token) {
  store.token = String(token || "").trim();
  localStorage.setItem("cheng_api_token", store.token);
}

export function clearToken() {
  store.token = "";
  localStorage.removeItem("cheng_api_token");
}

export function rememberConversation(id) {
  store.conversationId = id ? Number(id) : null;
  if (store.conversationId) localStorage.setItem("cheng_conversation_id", String(store.conversationId));
  else localStorage.removeItem("cheng_conversation_id");
}

export function cacheFresh(key, maxAge) {
  return Date.now() - (store.cacheAt[key] || 0) < maxAge;
}

export function cacheMessages(conversationId, messages) {
  store.messageCache[conversationId] = messages;
  store.cacheAt.messages[conversationId] = Date.now();
}

export function saveHomeCache(data) {
  store.home = data;
  store.cacheAt.home = Date.now();
  localStorage.setItem("cheng_home_v2", JSON.stringify(data));
  localStorage.setItem("cheng_home_v2_at", String(store.cacheAt.home));
}

export function saveConversationsCache(data) {
  store.conversations = data;
  store.cacheAt.conversations = Date.now();
  localStorage.setItem("cheng_conversations_v2", JSON.stringify(data));
  localStorage.setItem("cheng_conversations_v2_at", String(store.cacheAt.conversations));
}

export function saveMemoryCache(items) {
  store.memories = items;
  store.cacheAt.memories = Date.now();
  localStorage.setItem("cheng_memory_buckets_v2", JSON.stringify(items));
  localStorage.setItem("cheng_memory_buckets_v2_at", String(store.cacheAt.memories));
}

export function saveArchiveCache(archives, trend) {
  store.archives = archives;
  store.trend = trend;
  store.cacheAt.archives = Date.now();
  localStorage.setItem("cheng_memory_archives_v2", JSON.stringify(archives));
  localStorage.setItem("cheng_memory_trend_v2", JSON.stringify(trend));
  localStorage.setItem("cheng_memory_archives_v2_at", String(store.cacheAt.archives));
}

