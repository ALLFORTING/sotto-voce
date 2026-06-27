import { resolvedTheme, store } from "./store.js";

export const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[char]));

const paths = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M9.5 20v-6h5v6"/>',
  chat: '<path d="M4 5.5h16v11H9l-5 3v-14Z"/>',
  journal: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  memory: '<path d="M7 5h9a3 3 0 0 1 3 3v11H8a3 3 0 0 1-3-3V7a2 2 0 0 1 2-2Z"/><path d="M9 9h6M9 13h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1A7 7 0 0 0 15 6l-.4-2.6h-4L10 6a7 7 0 0 0-1.5 1L6 6 4 9.4 6.1 11a7 7 0 0 0 0 2L4 14.6 6 18l2.5-1a7 7 0 0 0 1.5 1l.5 2.6h4L15 18a7 7 0 0 0 1.5-1l2.5 1 2-3.4-2.1-1.6a7 7 0 0 0 .1-1Z"/>',
  menu: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m4 4 17 8-17 8 4-8-4-8Z"/><path d="M8 12h13"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m6 17 4-4 3 3 2-2 3 3"/>',
  copy: '<rect x="8" y="8" width="10" height="12" rx="2"/><path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
  star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4Z"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v6h-6"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 8h6M8 12h5"/>',
  bookOpen: '<path d="M4 5.5h7a3 3 0 0 1 3 3v11.5H7a3 3 0 0 0-3 3V5.5Z"/><path d="M20 5.5h-7a3 3 0 0 0-3 3v11.5h7a3 3 0 0 1 3 3V5.5Z"/><path d="M8 9h3M8 13h3M16 9h-3M16 13h-3"/>',
  ledger: '<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M5 15v5h14v-5"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pin: '<path d="M14 4l6 6-4 1-5 5-1 4-6-6 4-1 5-5 1-4Z"/>',
  textSize: '<path d="M4 6h10M9 6v12M14 10h6M17 10v8"/>'
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

export function tabbar(active) {
  const items = [
    ["/", "home", "主页", "home"],
    ["/chat", "chat", "聊天", "chat"],
    ["/journal", "jnl", "手记", "journal"],
    ["/memory", "mem", "记忆", "memory"],
    ["/settings", "set", "设置", "settings"]
  ];
  return `<nav class="tabbar">
    ${items.map(([path, id, label, ico]) => `<button class="tab ${active === id ? "active" : ""}" data-go="${path}">
      ${icon(ico)}<span>${label}</span>
    </button>`).join("")}
  </nav>`;
}

export function phone({ activeTab, body, overlays = "", hideTab = false }) {
  return `<div class="phone ${resolvedTheme()}">
    <section class="screen">${body}</section>
    ${hideTab ? "" : tabbar(activeTab)}
    <div class="phone-overlay-layer">${overlays}</div>
  </div>`;
}

export function subpageTop(title, right = "") {
  return `<header class="subpage-top">
    <button class="back" data-action="back">${icon("back")}</button>
    <div class="title">${esc(title)}</div>
    <div class="right">${right}</div>
  </header>`;
}

export function chatTop() {
  return `<header class="chat-top">
    <button class="icon-btn menu-left" data-action="drawer">${icon("menu")}</button>
    <div class="peer"><span>澄</span><span class="online-dot"></span></div>
    <div class="icon-btn chat-top-spacer" aria-hidden="true"></div>
  </header>`;
}

export function searchBar(placeholder, wide = false, value = "") {
  return `<div class="search-bar ${wide ? "wide" : ""}">
    ${icon("search")}<input id="${wide ? "memory-search" : "search-input"}" value="${esc(value)}" placeholder="${esc(placeholder)}">
  </div>`;
}

export function relativeTime(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  if (seconds < 172800) return "昨天";
  return formatDate(iso);
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Shanghai"
  });
}

export function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  });
}

export function plainMarkdown(value = "") {
  const inline = (text) => esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return String(value || "")
    .trimEnd()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((block) => `<p>${inline(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function plainText(value = "") {
  return esc(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

export function toast(message) {
  const layer = document.querySelector(".phone-overlay-layer");
  if (!layer) return;
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  layer.append(node);
  setTimeout(() => node.remove(), 2400);
}

export function tokenGate(message = "") {
  const body = `<main class="page">
    <form class="token-card" id="token-form">
      <h1>澄</h1>
      <p>${message ? esc(message) : "这是私人空间。请输入访问令牌，验证后会保存在这台设备上。"}</p>
      <input name="token" type="password" autocomplete="off" placeholder="Bearer token" required>
      <button class="primary" style="width:100%;margin-top:18px" type="submit">进入</button>
    </form>
  </main>`;
  return phone({ activeTab: "", hideTab: true, body });
}

export function loadingPage(text = "正在打开…") {
  return phone({ activeTab: "", hideTab: true, body: `<div class="loading-text">${esc(text)}</div>` });
}

export function errorPage(text) {
  return phone({ activeTab: "", hideTab: true, body: `<div class="error-text">${esc(text)}</div>` });
}

export function currentPhoneClass() {
  return `phone ${resolvedTheme()}`;
}

export function formValue(form) {
  return Object.fromEntries(new FormData(form));
}

export function maskKey(key = "") {
  const value = String(key || "");
  if (!value) return "";
  return `${"•".repeat(Math.min(22, Math.max(8, value.length - 4)))} ${value.slice(-4)}`;
}

export function currency(value) {
  return `¥ ${Number(value || 0).toFixed(2)}`;
}

export function tokenCount(value) {
  const num = Number(value || 0);
  if (num >= 1000) return `${(num / 1000).toFixed(num >= 10000 ? 0 : 1)}k`;
  return String(num);
}

export function invalidateSettings() {
  store.cacheAt.settings = 0;
}
