import { clearToken, store } from "./store.js";

function authHeaders(extra = {}) {
  return {
    ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}),
    ...extra
  };
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders({
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers || {})
    })
  });
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("cheng:unauthorized"));
    throw new Error("访问令牌无效，请重新输入。");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || data.error || `请求失败：${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export const api = {
  get: (path) => request(path),
  post: (path, data) => request(path, { method: "POST", body: JSON.stringify(data) }),
  patch: (path, data) => request(path, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (path) => request(path, { method: "DELETE" }),
  upload(file) {
    const body = new FormData();
    body.append("file", file);
    return request("/api/upload", { method: "POST", body });
  },
  uploadBook(file, title = "") {
    const body = new FormData();
    body.append("file", file);
    if (title) body.append("title", title);
    return request("/api/books", { method: "POST", body });
  }
};

export async function streamChat(payload, onEvent, path = "/api/chat") {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("cheng:unauthorized"));
    throw new Error("访问令牌无效，请重新输入。");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `发送失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      let event = "message";
      const data = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      onEvent(event, JSON.parse(data.join("\n")));
    }
  }
}
