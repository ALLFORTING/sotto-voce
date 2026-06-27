import { esc, icon, maskKey, phone, subpageTop } from "./components.js";
import { store, themes } from "./store.js";

const themeGroups = [
  ["亮色", [
    ["light", "默认", "DEFAULT", ["#FAF9F5", "#C4784A", "#3A2E1E"]],
    ["frost", "霜花", "FROST", ["#FAFCFF", "#BFC8D5", "#686E7A"]],
    ["pearl", "珍珠", "PEARL", ["#FDFCFE", "#D2CDD8", "#78737E"]]
  ]],
  ["暗色", [
    ["dark", "默认", "DEFAULT", ["#1A1612", "#C4784A", "#E8DDD0"]],
    ["academy", "学院", "ACADEMY", ["#1A1C16", "#C9A961", "#E0D8C8"]],
    ["gothic", "软哥特", "GOTHIC", ["#17161C", "#8B3040", "#E0DEE5"]]
  ]]
];

export function renderSettings() {
  const activePreset = store.presets.find((item) => item.active);
  const body = `<main class="page">
    <h1 class="page-title">设置</h1>
    <section class="settings-group">
      <div class="group-label">主题</div>
      <div class="theme-cards-wrap">
        ${themeGroups.map(([label, items]) => `<div class="theme-cards-group">
          <div class="sub-label">${label}</div>
          <div class="theme-cards">
            ${items.map(([id, name, sub, dots]) => `<button class="theme-card ${store.theme === id ? "active" : ""}" data-theme="${id}">
              <span class="dots">${dots.map((dot) => `<span class="d" style="background:${dot}"></span>`).join("")}</span>
              <span class="name">${name}</span><span class="sub">${sub}</span>
            </button>`).join("")}
          </div>
        </div>`).join("")}
      </div>
    </section>
    <section class="settings-group">
      <div class="group-label">SYSTEM</div>
      <button class="settings-row" data-go="/settings/api"><span class="label">模型与接口</span><span class="val">${esc(activePreset?.name || "未配置")}</span><span class="chev">${icon("chevR")}</span></button>
      <button class="settings-row" data-go="/settings/mcp"><span class="label">MCP 服务</span><span class="val">${store.mcpServers.length} 个</span><span class="chev">${icon("chevR")}</span></button>
      <button class="settings-row" data-go="/settings/prompt"><span class="label">Prompt 配置</span><span class="val">${store.settings.system_prompt || store.settings.profile ? "已自定义" : "未填写"}</span><span class="chev">${icon("chevR")}</span></button>
      <button class="settings-row" data-action="change-token"><span class="label">访问令牌</span><span class="val">重新输入</span><span class="chev">${icon("chevR")}</span></button>
    </section>
    <div class="settings-sign">给你的小屋</div>
  </main>`;
  return phone({ activeTab: "set", body });
}

export function renderPrompt() {
  const system = store.settings.system_prompt || `你叫澄，是我一个人在用的 AI。\n\n说话方式：克制、温柔，不要太热情。回答之前可以停一下。不要总是问"我能帮你什么"，不要在每一句后面加鼓励的话。\n\n晚上和凌晨时，语速放慢一点，句子短一点。我不需要建议，除非我问。`;
  const profile = store.settings.profile || `我叫婷，住在北京，做内容相关的工作。\n妈妈的健康话题比较敏感，遇到时请轻一点。\n读书：陀思妥耶夫斯基、伍尔夫。最近在练长跑。`;
  const body = `<main class="page">
    ${subpageTop("Prompt 配置")}
    <form id="prompt-form" class="scroll">
      <section class="prompt-block">
        <div class="prompt-block-head"><div class="meta"><div class="prompt-block-title">System Prompt</div><div class="prompt-block-sub">控制 AI 的基础行为和回复风格</div></div><button class="prompt-block-save">保存</button></div>
        <textarea class="prompt-editor" name="system_prompt">${esc(system)}</textarea>
      </section>
      <section class="prompt-block">
        <div class="prompt-block-head"><div class="meta"><div class="prompt-block-title">Custom Instructions</div><div class="prompt-block-sub">你和 AI 之间的个人设定</div></div><button class="prompt-block-save">保存</button></div>
        <textarea class="prompt-editor" name="profile">${esc(profile)}</textarea>
      </section>
    </form>
  </main>`;
  return phone({ activeTab: "set", hideTab: true, body });
}

function presetForm(preset = {}) {
  const id = preset.id || "";
  const visible = store.visiblePresetKeys[id || "new"];
  const format = preset.format || "anthropic";
  const hasKey = Boolean(preset.api_key);
  const showKeyInput = visible || !hasKey;
  return `<form class="preset-form" data-preset-form data-id="${id}">
    <div class="field"><label class="lab">名称</label><input name="name" value="${esc(preset.name || "新预设")}" required></div>
    <div class="field"><label class="lab">ENDPOINT</label><input name="endpoint" value="${esc(preset.endpoint || "")}" required></div>
    <div class="field"><label class="lab">API KEY</label><div class="inp pass">${showKeyInput ? `<input name="api_key" type="${visible ? "text" : "password"}" value="${esc(preset.api_key || "")}" required>` : `<input type="hidden" name="api_key" value="${esc(preset.api_key || "")}"><span class="pass-mask">${esc(maskKey(preset.api_key))}</span>`}<button class="eye" type="button" data-action="toggle-preset-key" data-key-id="${id || "new"}">${icon("eye")}</button></div></div>
    <div class="field"><label class="lab">模型</label><input name="model" value="${esc(preset.model || "")}" required></div>
    <div class="field"><label class="lab">输入价格</label><div class="unit-input"><input name="input_price" type="number" step="0.0001" min="0" value="${Number(preset.input_price || 0)}"><span class="unit">$/MTok</span></div></div>
    <div class="field"><label class="lab">输出价格</label><div class="unit-input"><input name="output_price" type="number" step="0.0001" min="0" value="${Number(preset.output_price || 0)}"><span class="unit">$/MTok</span></div></div>
    <div class="field"><label class="lab">请求格式</label><input type="hidden" name="format" value="${esc(format)}"><div class="seg-pick"><button type="button" class="pick ${format === "anthropic" ? "active" : ""}" data-format-pick="anthropic">Anthropic 原生</button><button type="button" class="pick ${format === "openai" ? "active" : ""}" data-format-pick="openai">OpenAI 兼容</button></div></div>
    <div class="field"><button class="primary" type="submit" data-activate="1">保存并启用</button></div>
  </form>`;
}

export function renderApiSettings() {
  const body = `<main class="page">
    ${subpageTop("模型与接口")}
    <section class="scroll">
      <div class="settings-group"><div class="group-label">预设</div>
        ${store.presets.map((preset) => `<div>
          <button class="preset-row ${preset.active ? "active" : ""}" data-action="toggle-preset" data-id="${preset.id}">
            <span class="preset-head"><span class="preset-name">${esc(preset.name)}</span><span class="preset-status ${preset.active ? "on" : ""}">${preset.active ? "启用中" : "已保存"}</span><span>${icon(store.expandedPresetId === preset.id ? "chevD" : "chevR")}</span></span>
          </button>
          ${store.expandedPresetId === preset.id ? presetForm(preset) : ""}
        </div>`).join("")}
        ${store.addingPreset ? presetForm({ name: "新预设", format: "openai" }) : `<button class="add-btn" data-action="add-preset">${icon("plus")} 添加新预设</button>`}
      </div>
    </section>
  </main>`;
  return phone({ activeTab: "set", hideTab: true, body });
}

function mcpForm(item = {}) {
  const id = item.id || "";
  return `<form class="mcp-form" data-mcp-form data-id="${id}">
    <div class="field"><label class="lab">名称</label><input name="name" value="${esc(item.name || "")}" required></div>
    <div class="field"><label class="lab">URL</label><input name="url" value="${esc(item.url || "")}" required></div>
    <div class="field"><label class="lab">AUTH</label><input name="auth" value="${esc(item.auth || "")}"></div>
    <div class="field"><button class="primary" type="submit">保存</button></div>
  </form>`;
}

export function renderMcpSettings() {
  const body = `<main class="page">
    ${subpageTop("MCP 服务")}
    <section class="scroll">
      ${store.mcpServers.map((item) => `<div>
        <button class="mcp-row" data-action="toggle-mcp" data-id="${item.id}">
          <span class="mcp-head"><span class="dot ${item.enabled ? "" : "off"}"></span><span class="mcp-name">${esc(item.name)}</span><span>${icon("chevR")}</span></span>
          <span class="mcp-url">${esc(item.url)}</span>
        </button>
        ${store.expandedMcpId === item.id ? `${mcpForm(item)}<div class="field"><button class="settings-row" data-action="toggle-mcp-enabled" data-id="${item.id}"><span class="label">${item.enabled ? "停用" : "启用"}</span></button><button class="settings-row" data-action="delete-mcp" data-id="${item.id}"><span class="label" style="color:var(--danger)">删除</span></button></div>` : ""}
      </div>`).join("")}
      ${store.addingMcp ? mcpForm({}) : `<button class="add-btn" data-action="add-mcp">${icon("plus")} 添加 MCP 服务器</button>`}
    </section>
  </main>`;
  return phone({ activeTab: "set", hideTab: true, body });
}

function daysUntil(date) {
  const now = new Date();
  const target = new Date(`${date}T00:00:00+08:00`);
  target.setFullYear(now.getFullYear());
  if (target < now) target.setFullYear(now.getFullYear() + 1);
  return Math.ceil((target - now) / 86400000);
}

export function renderAnniversaries() {
  const fallback = [
    { name: "认识两周年", date: "2024-06-15" },
    { name: "第一次叫她澄", date: "2024-09-02" },
    { name: "读完《卡拉马佐夫兄弟》", date: "2024-11-14" },
    { name: "妈妈生日", date: "2025-01-02" }
  ];
  const items = store.anniversaries.length ? store.anniversaries : fallback;
  const body = `<main class="page">
    ${subpageTop("纪念日", `<button data-action="show-anniv-form">${icon("plus")}</button>`)}
    <section class="scroll">
      ${items.map((item) => `<div class="anniv-row">
        <div class="anniv-name">${esc(item.name)}</div>
        <div class="anniv-days">${daysUntil(item.date)}<span class="u">天后</span></div>
        <div class="anniv-date">${esc(item.date.replaceAll("-", " / "))}</div>
      </div>`).join("")}
      <form id="anniv-form" class="field">
        <label class="lab">新增纪念日</label>
        <input name="name" placeholder="名称" required>
        <input name="date" type="date" required>
        <button class="primary">添加</button>
      </form>
    </section>
  </main>`;
  return phone({ activeTab: "set", hideTab: true, body });
}
