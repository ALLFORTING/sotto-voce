import { chatTop, esc, formatDate, formatTime, icon, phone, plainText, relativeTime } from "./components.js";
import { store } from "./store.js";

function aiBubbleTexts(value = "") {
  return String(value || "")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^\[\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}\]$/.test(part));
}

function aiBubblesHtml(message) {
  const parts = aiBubbleTexts(message.content);
  return parts.map((part) => `<div class="msg-bubble">${plainText(part)}</div>`).join("");
}

function thoughtContentHtml(text, done = false) {
  const parts = String(text || "").split(/\[mcp:([^\]]+)\]/);
  let html = '<div class="thought-timeline">';
  for (let i = 0; i < parts.length; i++) {
    const content = parts[i].trim();
    if (!content) continue;
    if (i % 2 === 0) {
      html += `<div class="thought-step"><span class="step-icon">${icon("clock")}</span><span class="step-text">${esc(content)}</span></div>`;
    } else {
      const name = content;
      html += `<div class="thought-step tool"><span class="tool-label">mcp</span><span class="tool-action">${esc(name)}</span></div>`;
    }
  }
  if (done) {
    html += `<div class="thought-step done"><span class="step-icon">${icon("check")}</span><span class="step-text">Done</span></div>`;
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
  return `<div class="thought">
    <button data-action="toggle-thought" ${text ? "" : "disabled"}>
      <span class="chev">${icon(open ? "chevD" : "chevR")}</span>
      <span>${label}</span>
    </button>
  </div>${open && text ? `<div class="thought-expanded">${thoughtContentHtml(text, !message.thinkingStarted)}</div>` : ""}`;
}

function toolsHtml(message) {
  return (message.tools || []).map((tool) => `<span class="tool-tag">${esc(tool)}</span>`).join("");
}

export function messageHtml(message, index, messages) {
  const role = message.role === "assistant" ? "ai" : "user";
  const previous = messages[index - 1];
  const showCenterTime = index === 0 || (
    message.created_at &&
    previous?.created_at &&
    new Date(message.created_at).toDateString() !== new Date(previous.created_at).toDateString()
  );
  const streamKey = message.streamKey ? ` data-stream-key="${esc(message.streamKey)}"` : "";
  const messageId = message.id ? ` data-message-id="${message.id}"` : "";
  const messageIndex = ` data-message-index="${index}"`;
  const content = role === "ai" ? aiBubblesHtml(message) : plainText(message.content || "");
  return `${showCenterTime && message.created_at ? `<div class="msg-time-center">${formatDate(message.created_at)} ${formatTime(message.created_at)}</div>` : ""}
    <article class="msg-row ${role} ${message.streaming ? "streaming" : ""} ${message.starred ? "starred" : ""}" data-role="${message.role}"${messageId}${streamKey}${messageIndex}>
      ${role === "ai" ? thoughtHtml(message) : ""}
      ${role === "ai" && toolsHtml(message) ? `<div class="tool-tags">${toolsHtml(message)}</div>` : ""}
      ${role === "ai" ? `<div class="ai-group">${content}</div>` : `<div class="msg-bubble">${content}</div>`}
      ${message.created_at ? `<div class="msg-foot">${formatTime(message.created_at)}</div>` : ""}
    </article>`;
}

function composerHtml() {
  const attachments = store.pendingAttachments.map((item, index) =>
    `<button class="attachment-chip" type="button" data-remove-attachment="${index}">${esc(item.name)} ×</button>`
  ).join("");
  return `<form class="composer" id="composer">
    ${attachments ? `<div class="pending-attachments">${attachments}</div>` : ""}
    <div class="row-input">
      <button class="plus ${store.plusOpen ? "open" : ""}" type="button" data-action="plus">${icon("plus")}</button>
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
      group.append(current);
      message.pendingBubbleBreak = false;
    }
    return current;
  };
  String(text).split(/(\n+)/).forEach((part) => {
    if (!part) return;
    if (/^\n+$/.test(part)) {
      if (current?.textContent.trim()) message.pendingBubbleBreak = true;
      return;
    }
    if (!part.trim() && !current) return;
    appendText(ensureBubble(), part);
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
    else if (bubble) bubble.innerHTML = plainText(message.content);
    if (!article.querySelector(".msg-foot")) {
      const foot = document.createElement("div");
      foot.className = "msg-foot";
      foot.textContent = formatTime(message.created_at);
      article.append(foot);
    }
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
