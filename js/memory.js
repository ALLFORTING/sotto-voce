import { esc, icon, phone, searchBar } from "./components.js";
import { store } from "./store.js";

const domains = ["全部", "人际", "内心", "数字", "日常", "兴趣", "学习", "事务", "身心", "feel"];

function bucketTitle(bucket) {
  return bucket.title || bucket.name || bucket.bucket || bucket.id || "未命名记忆";
}

function bucketKey(bucket) {
  return String(bucket.id || bucketTitle(bucket));
}

function bucketTags(bucket) {
  const tags = bucket.tags || bucket.keywords || bucket.domains || bucket.domain || [];
  if (Array.isArray(tags)) return tags.slice(0, 4);
  return String(tags).split(/[,\s，、]+/).filter(Boolean).slice(0, 4);
}

function bucketState(bucket) {
  const state = String(bucket.state || bucket.status || "").toLowerCase();
  if (bucket.sealed || state.includes("sealed") || state.includes("封存")) return "sealed";
  if (state.includes("digested") || state.includes("沉底") || state.includes("sink")) return "digested";
  if (bucket.pinned || state.includes("pin")) return "pinned";
  if (state.includes("sleep") || state.includes("dormant") || state.includes("休眠")) return "dormant";
  return "active";
}

function moodClass(bucket) {
  const text = `${bucket.mood || ""} ${bucket.summary || ""}`;
  if (/冷|疲|难|迷|痛|焦|sad|tired/i.test(text)) return "cool";
  if (/暖|温|开心|平静|充实|warm|happy/i.test(text)) return "warm";
  return "";
}

function impClass(bucket) {
  const value = Number(bucket.importance || bucket.score || 5);
  if (value >= 8) return "high";
  if (value >= 4) return "mid";
  return "low";
}

function bucketCard(bucket) {
  const tags = bucketTags(bucket);
  const title = bucketTitle(bucket);
  const state = bucketState(bucket);
  const muted = ["dormant", "digested", "sealed"].includes(state);
  return `<button class="mem-v2 ${muted ? state : ""}" data-bucket-edit="${esc(bucketKey(bucket))}">
    <span class="imp-bar ${impClass(bucket)}"></span>
    <span class="head-row">
      ${state === "pinned" ? `<span class="pin">${icon("pin")}</span>` : ""}
      <span class="mood-dot ${moodClass(bucket)}"></span>
      <span class="title-t">${esc(title)}</span>
    </span>
    <span class="tags">${tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</span>
    <span class="meta">${esc(bucket.updated_at || bucket.last_updated || "6 月 7 日更新")} · ${bucket.count || bucket.message_count || bucket.items || 1} 条</span>
  </button>`;
}

function filteredBuckets() {
  const query = store.memoryQuery.trim().toLowerCase();
  return (store.memories || []).filter((bucket) => {
    const text = `${bucketTitle(bucket)} ${bucket.summary || ""} ${bucketTags(bucket).join(" ")}`.toLowerCase();
    const domainOk = store.memoryDomain === "全部" || text.includes(store.memoryDomain.toLowerCase());
    return domainOk && (!query || text.includes(query));
  });
}

function renderBucketSections() {
  const buckets = filteredBuckets();
  const groups = [
    ["钉选 · PINNED", buckets.filter((bucket) => bucketState(bucket) === "pinned")],
    ["活跃 · ACTIVE", buckets.filter((bucket) => bucketState(bucket) === "active")],
    ["休眠 · DORMANT", buckets.filter((bucket) => bucketState(bucket) === "dormant")],
    ["沉底 · DIGESTED", buckets.filter((bucket) => bucketState(bucket) === "digested")],
    ["封存 · SEALED", buckets.filter((bucket) => bucketState(bucket) === "sealed")]
  ];
  const fallback = [
    { title: "关于你最近在写的东西", tags: ["内心", "WRITING"], importance: 9, pinned: true, count: 14 },
    { title: "和母亲的几次通话", tags: ["人际", "FAMILY"], importance: 8, count: 8 },
    { title: "睡眠和早晨的状态", tags: ["身心", "RECURRING"], importance: 6, count: 21 },
    { title: "那本读到一半的陀思妥耶夫斯基", tags: ["学习"], importance: 6, count: 5 },
    { title: "想去的几个城市", tags: ["日常"], importance: 2, state: "dormant", count: 3 }
  ];
  const sourceGroups = buckets.length ? groups : [
    ["钉选 · PINNED", fallback.filter((item) => item.pinned)],
    ["活跃 · ACTIVE", fallback.filter((item) => !item.pinned && item.state !== "dormant")],
    ["休眠 · DORMANT", fallback.filter((item) => item.state === "dormant")],
    ["沉底 · DIGESTED", fallback.filter((item) => item.state === "digested")],
    ["封存 · SEALED", fallback.filter((item) => item.state === "sealed")]
  ];
  return sourceGroups.map(([label, items]) => items.length ? `<div class="section-divider">${label}</div><div class="mem-list-v2">${items.map(bucketCard).join("")}</div>` : "").join("");
}

function moodChart() {
  return `<section class="mood-chart">
    <div class="head"><span>近 30 天 · 心情曲线</span><span>← 滑动</span></div>
    <div class="stage">
      <svg viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="mood-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="currentColor" stop-opacity=".18"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
        <path d="M0 48 H300" stroke="var(--border)" stroke-dasharray="2 3" opacity=".6"/>
        <path d="M0 44 C 20 42, 32 18, 48 16 S 80 22, 96 38 S 132 58, 150 54 S 178 24, 196 18 S 228 12, 244 10 S 274 34, 300 18 L300 64 L0 64 Z" fill="url(#mood-fill)" stroke="none"/>
        <path d="M0 44 C 20 42, 32 18, 48 16 S 80 22, 96 38 S 132 58, 150 54 S 178 24, 196 18 S 228 12, 244 10 S 274 34, 300 18" stroke="var(--accent)" stroke-width="1.5" fill="none"/>
        <circle cx="48" cy="16" r="2" fill="var(--accent)" stroke="none"/><circle cx="150" cy="54" r="2" fill="var(--accent)" stroke="none"/><circle cx="244" cy="10" r="2.5" fill="var(--accent)" stroke="none"/>
      </svg>
    </div>
    <div class="axis"><span>5/10</span><span>5/20</span><span>5/30</span><span>6/9</span></div>
  </section>`;
}

function archiveRows() {
  const fallback = [
    { id: "placeholder-1", date: "2026-06-07", mood: "平静", summary: "和澄说了一下午写作的事，结尾时我们都没急着收尾。" },
    { id: "placeholder-2", date: "2026-06-04", mood: "疲惫", summary: "凌晨两点睡不着，澄陪我把这一周捋了一遍。" },
    { id: "placeholder-3", date: "2026-05-30", mood: "温柔", summary: "和母亲通话之后聊起小时候那条河边的下午。" },
    { id: "placeholder-4", date: "2026-05-22", mood: "迷茫", summary: "关于要不要离开现在的工作。没有结论，但松了一口气。" }
  ];
  const source = store.archives.length ? store.archives : fallback;
  return source.slice(0, 30).map((item, index) => {
    const date = String(item.date || "").split("-");
    const key = String(item.id || `${item.date || "archive"}-${index}`);
    const open = store.archiveOpen === key;
    const full = item.content || [item.summary, item.highlights].filter(Boolean).join("\n\n");
    return `<article class="archive-item ${open ? "expanded" : ""}" data-archive-id="${esc(key)}">
      <div class="archive-date">${Number(date[1] || 6)} / ${Number(date[2] || 7)}<div class="y">${esc(date[0] || "2026")}</div></div>
      <div><span class="mood">${esc(item.mood || "平静")}</span><div class="summary">${esc(item.summary || item.content || "")}</div>
      ${open ? `<div class="archive-full">${esc(full || item.summary || "")}</div>` : ""}</div>
    </article>`;
  }).join("");
}

export function renderMemory(mode = "bucket") {
  const archive = mode === "archive";
  const body = `<main class="page">
    <h1 class="page-title">记忆</h1>
    ${searchBar("搜索记忆…", true, store.memoryQuery)}
    <div class="seg">
      <button class="seg-item ${archive ? "" : "active"}" data-go="/memory">记忆桶</button>
      <button class="seg-item ${archive ? "active" : ""}" data-go="/memory/archive">对话归档</button>
    </div>
    <section class="scroll">
      ${archive ? `${moodChart()}${store.archiveLoading ? `<div class="archive-hint">后台更新中，完成后会自动替换缓存。</div>` : ""}<div class="mem-list">${archiveRows()}</div>` : `<div class="dom-filter">
        ${domains.map((domain) => `<button class="chip-dom ${domain === store.memoryDomain ? "active" : ""}" data-domain="${domain}">${domain}</button>`).join("")}
      </div>${renderBucketSections()}`}
    </section>
  </main>`;
  return phone({ activeTab: "mem", body, overlays: renderBucketEdit() });
}

export function renderBucketEdit() {
  if (!store.bucketEdit) return "";
  const bucket = (store.memories || []).find((item) => bucketKey(item) === store.bucketEdit || bucketTitle(item) === store.bucketEdit) || {};
  const title = bucketTitle(bucket);
  const tags = bucketTags(bucket);
  const facts = [
    bucket.summary,
    bucket.content,
    bucket.description,
    ...(Array.isArray(bucket.core_facts) ? bucket.core_facts : []),
    ...(Array.isArray(bucket.highlights) ? bucket.highlights : [])
  ].filter(Boolean);
  const content = facts.join("\n") || "这个桶暂时没有详细摘要；列表中的标题、标签、重要度和状态已按 OB 返回数据带入。";
  const importance = Math.max(0, Math.min(10, Number(bucket.importance ?? bucket.score ?? (Number(bucket.weight || 0) * 10) ?? 5) || 5));
  const percent = Math.round(importance * 10);
  const state = bucketState(bucket);
  return `<div class="edit-sheet-scrim" data-action="close-overlay"></div>
    <section class="edit-sheet">
      <div class="grab"></div>
      <div class="es-body">
        <div class="field"><div class="lab">桶 · BUCKET</div><div class="title-input">${esc(title)}</div></div>
        <div class="field"><div class="lab">内容</div><div class="content-box">${esc(content)}</div></div>
        <div class="field"><div class="lab">标签</div><div class="tags-row">${tags.map((tag) => `<span class="tag-pill">${esc(tag)}</span>`).join("") || `<span class="tag-pill">未标记</span>`}<span class="tag-pill add">+ 添加</span></div></div>
        <div class="field"><div class="imp-head"><span class="lab">重要度</span><span class="imp-num">${importance.toFixed(importance % 1 ? 1 : 0)}</span></div><div class="imp-track"><span class="fill" style="width:${percent}%"></span><span class="knob" style="left:${percent}%"></span></div></div>
        <div class="field"><div class="lab">状态</div><div class="status-seg">
          <button class="opt ${state === "active" ? "active" : ""}">正常</button>
          <button class="opt ${state === "dormant" ? "active" : ""}">休眠</button>
          <button class="opt ${state === "digested" ? "active" : ""}">沉底</button>
          <button class="opt ${state === "sealed" ? "active" : ""}">封存</button>
          <button class="opt ${state === "pinned" ? "active" : ""}">钉选</button>
        </div></div>
      </div>
      <footer class="es-foot"><button class="btn delete">删 除</button><button class="btn save" data-action="close-overlay">保 存</button></footer>
    </section>`;
}
