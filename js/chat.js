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

function dateParts(value) {
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
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
  const content = role === "ai" ? aiBubblesHtml(message) : messageBubbleHtml({
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
  return `<form class="composer" id="composer">
    ${attachments ? `<div class="pending-attachments">${attachments}</div>` : ""}
    <div class="row-input">
      <button class="plus ${store.plusOpen ? "open" : ""}" type="button" data-action="plus">${icon("paperclip")}</button>
      <textarea name="content" rows="1" placeholder="说点什么…">${esc(store.chatDraft)}</textarea>
      <button class="clock" type="button" title="搜索聊天" data-go="/chat/search">${icon("clock")}</button>
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
    return `<div class="overlay-scrim" data-action="close-overlay"></div>
      <section class="long-press-menu" style="left:28px;top:138px">
        <button class="opt" data-conversation-action="rename"><span>重命名</span>${icon("edit")}</button>
        <button class="opt danger" data-conversation-action="delete"><span>删除</span>${icon("trash")}</button>
      </section>`;
  }
  if (store.longPress.role === "book") {
    return `<div class="overlay-scrim" data-action="close-overlay"></div>
      <section class="long-press-menu" style="left:28px;top:138px">
        <button class="opt" data-book-action="rename"><span>重命名</span>${icon("edit")}</button>
        <button class="opt danger" data-book-action="delete"><span>删除</span>${icon("trash")}</button>
      </section>`;
  }
  const rect = store.longPress.rect || { left: 28, top: 260, bottom: 320, width: 220 };
  const left = store.longPress.role === "assistant"
    ? Math.max(18, rect.left)
    : Math.max(18, Math.min(393 - 212, rect.left + rect.width - 184));
  const menuHeight = 180;
  const maxBottom = 750;
  const top = (rect.bottom + 8 + menuHeight > maxBottom)
    ? Math.max(8, rect.top - menuHeight)
    : Math.min(maxBottom - menuHeight, rect.bottom + 8);
  const ai = store.longPress.role === "assistant";
  return `<div class="overlay-scrim chat-only" data-action="close-overlay"></div>
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

export function updateThoughtDom(row, message) {
  if (!row) return;
  row.querySelector(".thought")?.remove();
  row.querySelector(".thought-expanded")?.remove();
  const html = thoughtHtml(message);
  if (html) row.insertAdjacentHTML("afterbegin", html);
}

export function updateStreamMeta(message, final = false) {
  const { article, group, bubble } = streamNodes(message);
  if (!article) return;
  if (final) {
    article.classList.remove("streaming");
    message.thinkingOpen = false;
    if (message.id) article.dataset.messageId = message.id;
    updateThoughtDom(article, message);
    if (group) group.innerHTML = aiBubblesHtml(message);
    else if (bubble) bubble.outerHTML = messageBubbleHtml({ role: "ai", text: message.content, message, tail: true });
  } else {
    updateThoughtDom(article, message);
  }
}

let autoFollow = true;
let scrollFrame = 0;

export function scrollChat(force = false) {
  if (force) autoFollow = true;
  if (!force && !autoFollow) return;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const node = document.querySelector("#chat-stream");
    if (node) node.scrollTop = node.scrollHeight;
  });
}

export function updateAutoFollow(event) {
  if (event.target?.id !== "chat-stream") return;
  const node = event.target;
  autoFollow = node.scrollHeight - node.scrollTop - node.clientHeight <= 56;
}
