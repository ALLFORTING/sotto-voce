import { chatTop, esc, formatTime, icon, phone, plainText, relativeTime } from "./components.js";
import { store } from "./store.js";

function aiBubbleTexts(value = "") {
  const timestampLine = /^\[\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}\]$/;
  const cleaned = String(value || "")
    .split(/\n/)
    .map((part) => part.trim())
    .filter((part) => !timestampLine.test(part))
    .join("\n")
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function bubbleMetaHtml(message, role, read = false) {
  if (!message.created_at) return "";
  return `<span class="bubble-time">${formatTime(message.created_at)}${role === "user" && read ? `<span class="read-checks">${icon("checks")}</span>` : ""}</span>`;
}

function bubbleContentHtml(text, role) {
  const content = String(text || "").trim();
  if (!content) return "";
  return `<span class="btext">${plainText(content)}<span class="tspace ${role}"></span></span>`;
}

function messageBubbleHtml({ role, text, message, tail = true, read = false, attachments = "" }) {
  return `<div class="msg-bubble ${tail ? "tail" : ""} ${message.created_at ? "has-time" : ""}">
    ${bubbleContentHtml(text, role)}
    ${attachments}
    ${bubbleMetaHtml(message, role, read)}
  </div>`;
}

function inlineMessageEditHtml(message) {
  const value = store.editingMessageDraft ?? message.content ?? "";
  return `<div class="msg-bubble tail inline-edit-bubble">
    <div class="inline-message-edit">
      <textarea data-inline-edit="${message.id}" rows="1">${esc(value)}</textarea>
      ${attachmentsHtml(message)}
      <div class="actions">
        <button type="button" class="cancel" data-action="cancel-inline-edit" data-message-id="${message.id}">取消</button>
        <button type="button" class="send-edit" data-action="send-inline-edit" data-message-id="${message.id}">发送</button>
      </div>
    </div>
  </div>`;
}

function aiBubblesHtml(message) {
  const parts = aiBubbleTexts(message.content);
  return parts.map((part, index) => messageBubbleHtml({
    role: "ai",
    text: part,
    message,
    tail: index === parts.length - 1
  })).join("");
}

function splitThoughtParagraphs(value = "") {
  return String(value || "")
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseThoughtSteps(text = "") {
  const chunks = String(text || "").split(/\[mcp:([^\]]+)\]/);
  const steps = [];
  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i].trim();
    if (!content) continue;
    if (i % 2 === 0) {
      splitThoughtParagraphs(content).forEach((paragraph) => {
        steps.push({ text: paragraph, tools: [] });
      });
    } else {
      const previous = steps[steps.length - 1];
      if (previous) previous.tools.push(content);
      else steps.push({ text: "", tools: [content] });
    }
  }
  if (!steps.length && String(text || "").trim()) {
    steps.push({ text: String(text || "").trim(), tools: [] });
  }
  return steps;
}

function thoughtToolHtml(name) {
  const dotIndex = name.indexOf(".");
  const server = dotIndex > -1 ? name.slice(0, dotIndex) : "mcp";
  const action = dotIndex > -1 ? name.slice(dotIndex + 1) : name;
  return `<span class="mcp-tag"><span>${esc(server)}</span><span>${esc(action)}</span></span>`;
}

function thoughtContentHtml(text, done = false) {
  const steps = parseThoughtSteps(text);
  let html = '<div class="thought-body">';
  steps.forEach((step) => {
    html += `<div class="tstep">
      <span class="tmark">${icon("clock")}</span>
      <div class="tbody">
        ${step.text ? `<div class="ttext">${esc(step.text)}</div>` : ""}
        ${step.tools.length ? `<div class="mcp-tags">${step.tools.map(thoughtToolHtml).join("")}</div>` : ""}
      </div>
    </div>`;
  });
  if (done) {
    html += `<div class="tstep done"><span class="tmark">${icon("check")}</span><div class="tbody"><div class="ttext">Done</div></div></div>`;
  }
  html += "</div>";
  return html;
}

function thoughtHtml(message) {
  const text = String(message.thinking || "").trim();
  if (!text && !message.thinkingStarted) return "";
  const open = Boolean(message.thinkingOpen);
  const label = message.thinkingStarted
    ? "Thinking..."
    : `Thought for ${Number(message.thinking_seconds || 0).toFixed(1)}s`;
  return `<div class="thought thought-h">
    <button data-action="toggle-thought" ${text ? "" : "disabled"}>
      <span class="chev">${icon(open ? "chevD" : "chevR")}</span>
      <span>${label}</span>
    </button>
  </div>${open && text ? `<div class="thought-expanded">${thoughtContentHtml(text, !message.thinkingStarted)}</div>` : ""}`;
}

function toolsHtml(message) {
  return (message.tools || []).map((tool) => `<span class="tool-tag">${esc(tool)}</span>`).join("");
}

function messageAttachments(message) {
  const raw = message.attachments;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function attachmentsHtml(message) {
  const attachments = messageAttachments(message);
  if (!attachments.length) return "";
  const items = attachments.map((item) => {
    const name = esc(item.name || "附件");
    const path = esc(item.path || "");
    if (item.type === "image" && item.path) {
      return `<a class="msg-attachment image" href="${path}" target="_blank" rel="noopener">
        <img src="${path}" alt="${name}" loading="lazy">
      </a>`;
    }
    return `<a class="msg-attachment file" href="${path || "#"}" target="_blank" rel="noopener">
      ${icon("file")}<span>${name}</span>
    </a>`;
  }).join("");
  return `<div class="msg-attachments">${items}</div>`;
}

const chinaDateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function dateParts(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return { year, month, day };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(chinaDateParts.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function localDateKey(value) {
  const parts = dateParts(value);
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dayStart(parts) {
  return new Date(parts.year, parts.month - 1, parts.day);
}

function dateDividerLabel(value) {
  const parts = dateParts(value);
  const todayParts = dateParts(new Date());
  if (!parts || !todayParts) return "";
  const today = dayStart(todayParts);
  const messageDay = dayStart(parts);
  const diffDays = Math.round((today - messageDay) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const monthDay = `${parts.month}月${parts.day}日`;
  return parts.year === todayParts.year
    ? monthDay
    : `${parts.year}年${monthDay}`;
}

function shouldShowDateDivider(message, previous) {
  if (!message.created_at) return false;
  return !previous?.created_at || localDateKey(message.created_at) !== localDateKey(previous.created_at);
}

function hasAiReplyAfter(index, messages) {
  return messages.slice(index + 1).some((item) =>
    item.role === "assistant" && (String(item.content || "").trim() || String(item.thinking || "").trim())
  );
}

export function messageHtml(message, index, messages) {
  const role = message.role === "assistant" ? "ai" : "user";
  const previous = messages[index - 1];
  const dateDivider = shouldShowDateDivider(message, previous)
    ? `<div class="msg-date-divider">${dateDividerLabel(message.created_at)}</div>`
    : "";
  const streamKey = message.streamKey ? ` data-stream-key="${esc(message.streamKey)}"` : "";
  const messageId = message.id ? ` data-message-id="${message.id}"` : "";
  const messageIndex = ` data-message-index="${index}"`;
  const read = role === "user" && hasAiReplyAfter(index, messages);
  const editing = role === "user" && message.id && Number(store.editingMessageId) === Number(message.id);
  const content = role === "ai"
    ? aiBubblesHtml(message)
    : editing
      ? inlineMessageEditHtml(message)
      : messageBubbleHtml({
        role,
        text: message.content || "",
        message,
        tail: true,
        read,
        attachments: attachmentsHtml(message)
      });
  return `${dateDivider}
    <article class="msg-row ${role} ${message.streaming ? "streaming" : ""} ${message.starred ? "starred" : ""}" data-role="${message.role}"${messageId}${streamKey}${messageIndex}>
      ${role === "ai" ? thoughtHtml(message) : ""}
      ${role === "ai" && toolsHtml(message) ? `<div class="tool-tags">${toolsHtml(message)}</div>` : ""}
      ${role === "ai" ? `<div class="ai-group">${content}</div>` : content}
    </article>`;
}

function composerHtml() {
  const attachments = store.pendingAttachments.map((item, index) =>
    `<button class="attachment-chip" type="button" data-remove-attachment="${index}">${esc(item.name)} ×</button>`
  ).join("");
  const contextPct = Number(store.contextPct || 0);
  const contextHint = contextPct >= 0.8
    ? `<span class="context-hint">${Math.round(contextPct * 100)}%</span>`
    : "";
  return `<form class="composer" id="composer">
    ${attachments ? `<div class="pending-attachments">${attachments}</div>` : ""}
    <div class="row-input">
      <button class="plus ${store.plusOpen ? "open" : ""}" type="button" data-action="plus">${icon("paperclip")}</button>
      <div class="textarea-wrap">
        <textarea name="content" rows="1" placeholder="说点什么…">${esc(store.chatDraft)}</textarea>
        ${contextHint}
      </div>
      <button class="send" type="submit" ${store.chatDraft.trim() || attachments ? "" : "disabled"}>${icon("send")}</button>
    </div>
  </form>`;
}

export function renderDrawer() {
  if (!store.drawerOpen) return "";
  const groups = [["今天", []], ["昨天", []], ["更早", []]];
  const now = new Date();
  for (const item of store.conversations) {
    const updated = item.updated_at ? new Date(item.updated_at) : now;
    const days = Math.floor((now - updated) / 86400000);
    groups[days < 1 ? 0 : days < 2 ? 1 : 2][1].push(item);
  }
  return `<div class="drawer-scrim" data-action="close-overlay"></div>
    <aside class="drawer">
      <button class="new-btn" data-action="new-conversation">${icon("plus")} 新建对话</button>
      <div class="drawer-list">
        ${groups.map(([label, items]) => items.length ? `<div class="drawer-group">${label}</div>
          ${items.map((item) => `<button class="drawer-item ${item.id === store.conversationId ? "active" : ""}" data-conversation="${item.id}">
            <span class="drawer-title">${esc(item.title || "新对话")}</span>
            <span class="drawer-meta">${relativeTime(item.updated_at)}</span>
          </button>`).join("")}` : "").join("")}
      </div>
    </aside>`;
}

export function renderPlusMenu() {
  if (!store.plusOpen) return "";
  return `<div class="overlay-scrim chat-only" data-action="close-plus"></div>
    <section class="plus-menu">
      <label class="opt">${icon("file")}<span>文件</span><input hidden type="file" data-upload-file></label>
      <label class="opt">${icon("image")}<span>图片</span><input hidden type="file" accept="image/*" data-upload-file></label>
    </section>`;
}

export function renderLongPressMenu() {
  if (!store.longPress) return "";
  if (store.longPress.role === "conversation") {
    return `<div class="overlay-scrim long-press-scrim" data-action="close-overlay"></div>
      <section class="long-press-menu" style="left:28px;top:138px">
        <button class="opt" data-conversation-action="rename"><span>重命名</span>${icon("edit")}</button>
        <button class="opt danger" data-conversation-action="delete"><span>删除</span>${icon("trash")}</button>
      </section>`;
  }
  if (store.longPress.role === "book") {
    return `<div class="overlay-scrim long-press-scrim" data-action="close-overlay"></div>
      <section class="long-press-menu" style="left:28px;top:138px">
        <button class="opt" data-book-action="rename"><span>重命名</span>${icon("edit")}</button>
        <button class="opt danger" data-book-action="delete"><span>删除</span>${icon("trash")}</button>
      </section>`;
  }
  const rect = store.longPress.rect || { left: 28, top: 260, bottom: 320, width: 220 };
  const viewport = store.longPress.viewport || { width: 393, height: 750 };
  const left = store.longPress.role === "assistant"
    ? Math.max(18, Math.min(viewport.width - 202, rect.left))
    : Math.max(18, Math.min(viewport.width - 202, rect.left + rect.width - 184));
  const menuItems = store.longPress.menuItems || 4;
  const menuHeight = 4 + menuItems * 44 + Math.max(0, menuItems - 1) + 8;
  const margin = 8;
  const below = rect.bottom + margin;
  const top = below + menuHeight <= viewport.height - margin
    ? below
    : Math.max(margin, rect.top - menuHeight - margin);
  const ai = store.longPress.role === "assistant";
  const float = store.longPress.floatHtml && store.longPress.floatRect
    ? `<div class="long-press-float ${esc(store.longPress.role || "")}" style="left:${store.longPress.floatRect.left}px;top:${store.longPress.floatRect.top}px;width:${store.longPress.floatRect.width}px">${store.longPress.floatHtml}</div>`
    : "";
  return `<div class="overlay-scrim chat-only long-press-scrim" data-action="close-overlay"></div>
    ${float}
    <section class="long-press-menu" style="left:${left}px;top:${top}px">
      <button class="opt" data-message-action="copy"><span>复制</span>${icon("copy")}</button>
      <button class="opt" data-message-action="star"><span>${store.longPress.starred ? "取消星标" : "星标"}</span>${icon("star")}</button>
      <button class="opt" data-message-action="${ai ? "regenerate" : "edit"}"><span>${ai ? "重新生成" : "编辑"}</span>${icon(ai ? "refresh" : "edit")}</button>
      <button class="opt danger" data-message-action="delete"><span>删除</span>${icon("trash")}</button>
    </section>`;
}

export function renderChat() {
  const width = Math.max(2, Math.min(100, store.contextPct * 100));
  const fillClass = store.contextPct >= 0.95 ? "full" : store.contextPct >= 0.85 ? "warn" : "";
  const body = `<main class="page chat-page">
    ${chatTop()}
    <div class="ctx-bar"><div class="fill ${fillClass}" style="width:${width}%"></div></div>
    <div class="chat-fade"></div>
    ${store.messages.length ? `<section class="chat-stream" id="chat-stream">${store.messages.map(messageHtml).join("")}</section>` : `<section class="chat-empty">在这里说点什么吧，<br>今天的事，或者别的什么。</section>`}
    ${composerHtml()}
  </main>`;
  return phone({
    activeTab: "chat",
    body,
    overlays: renderDrawer() + renderPlusMenu() + renderLongPressMenu()
  });
}

export function streamNodes(message) {
  const article = document.querySelector(`[data-stream-key="${message.streamKey}"]`);
  if (!article) return {};
  const group = article.querySelector(".ai-group");
  return {
    article,
    group,
    bubble: group?.lastElementChild || article.querySelector(".msg-bubble")
  };
}

export function appendStreamText(message, text) {
  const { group } = streamNodes(message);
  if (!group || !text) return;
  let current = group.lastElementChild;
  const appendText = (target, value) => {
    if (!target || !value) return;
    const last = target.lastChild;
    if (last?.nodeType === Node.TEXT_NODE) last.appendData(value);
    else target.append(document.createTextNode(value));
  };
  const ensureBubble = () => {
    if (!current || message.pendingBubbleBreak) {
      current = document.createElement("div");
      current.className = "msg-bubble";
      current.innerHTML = '<span class="btext"></span>';
      group.append(current);
      message.pendingBubbleBreak = false;
    }
    return current;
  };
  String(text).split(/(\n+)/).forEach((part) => {
    if (!part) return;
    if (/^\n+$/.test(part)) {
      message.pendingStreamNewlines = (message.pendingStreamNewlines || 0) + part.length;
      return;
    }
    if (message.pendingStreamNewlines) {
      if (message.pendingStreamNewlines >= 2 && current?.textContent.trim()) {
        message.pendingBubbleBreak = true;
      } else if (current?.textContent.trim()) {
        appendText(current.querySelector(".btext") || current, "\n".repeat(message.pendingStreamNewlines));
      }
      message.pendingStreamNewlines = 0;
    }
    if (!part.trim() && !current) return;
    const bubble = ensureBubble();
    appendText(bubble.querySelector(".btext") || bubble, part);
  });
}

function thoughtRenderKey(message, final = false) {
  const hasText = Boolean(String(message.thinking || "").trim());
  return [
    final ? "final" : "stream",
    message.thinkingStarted ? "thinking" : "done",
    hasText ? "text" : "empty",
    message.thinkingOpen ? "open" : "closed",
    message.thinkingOpen ? String(message.thinking || "").length : 0,
    Number(message.thinking_seconds || 0).toFixed(1),
    (message.tools || []).length
  ].join(":");
}

export function updateThoughtDom(row, message, options = {}) {
  if (!row) return;
  const key = thoughtRenderKey(message, options.final);
  if (!options.force && row.dataset.thoughtKey === key) return;
  row.querySelector(".thought")?.remove();
  row.querySelector(".thought-expanded")?.remove();
  const html = thoughtHtml(message);
  if (html) row.insertAdjacentHTML("afterbegin", html);
  row.dataset.thoughtKey = key;
}

export function updateStreamMeta(message, final = false) {
  const { article, group, bubble } = streamNodes(message);
  if (!article) return;
  if (final) {
    article.classList.remove("streaming");
    message.thinkingOpen = false;
    if (message.id) article.dataset.messageId = message.id;
    updateThoughtDom(article, message, { final: true, force: true });
    if (group) group.innerHTML = aiBubblesHtml(message);
    else if (bubble) bubble.outerHTML = messageBubbleHtml({ role: "ai", text: message.content, message, tail: true });
  } else {
    updateThoughtDom(article, message);
  }
}

let autoFollow = true;
let scrollFrame = 0;
let userTouchingChat = false;
const AUTO_FOLLOW_PX = 96;

function nearChatBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= AUTO_FOLLOW_PX;
}

function chatStreamFromEvent(event) {
  return event.target?.closest?.("#chat-stream");
}

function finishChatTouch() {
  const node = document.querySelector("#chat-stream");
  userTouchingChat = false;
  if (node) autoFollow = nearChatBottom(node);
}

export function scrollChat(force = false) {
  if (force) autoFollow = true;
  if (!force && userTouchingChat) return;
  if (!force && !autoFollow) return;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const node = document.querySelector("#chat-stream");
    if (!node) return;
    if (!force && (userTouchingChat || !nearChatBottom(node))) {
      autoFollow = false;
      return;
    }
    node.scrollTop = node.scrollHeight;
  });
}

export function updateAutoFollow(event) {
  if (event.target?.id !== "chat-stream") return;
  if (userTouchingChat) {
    autoFollow = false;
    return;
  }
  autoFollow = nearChatBottom(event.target);
}

document.addEventListener("touchstart", (event) => {
  if (!chatStreamFromEvent(event)) return;
  userTouchingChat = true;
  autoFollow = false;
}, { passive: true });

document.addEventListener("touchend", finishChatTouch, { passive: true });
document.addEventListener("touchcancel", finishChatTouch, { passive: true });
