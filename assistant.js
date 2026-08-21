(() => {
  if (document.querySelector("[data-nei-assistant]")) return;
  const launcher = document.createElement("button");
  launcher.className = "nei-assistant-launcher"; launcher.type = "button"; launcher.dataset.neiAssistant = ""; launcher.setAttribute("aria-expanded", "false"); launcher.setAttribute("aria-controls", "nei-assistant-panel");
  launcher.innerHTML = '<i aria-hidden="true"></i><span>Ask the property AI</span>';
  const panel = document.createElement("section");
  panel.className = "nei-assistant-panel"; panel.id = "nei-assistant-panel"; panel.hidden = true; panel.setAttribute("aria-label", "Nepal Estate Index AI assistant");
  panel.innerHTML = `<header class="nei-assistant-head"><div><strong>Property & market guide</strong><span data-assistant-mode>Ollama + live listing index</span></div><button type="button" aria-label="Close assistant" data-assistant-close>×</button></header>
    <div class="nei-assistant-log" data-assistant-log><div class="nei-message is-assistant">Tell me what you want to do and how much space you need. I’ll search the indexed listings, explain the strongest matches, and keep every result inside this website.</div>
      <div class="nei-assistant-examples"><button type="button">Find 1 ropani of land for a cafe</button><button type="button">Compare Kathmandu house prices</button><button type="button">Rent a 2 bedroom apartment</button></div></div>
    <form class="nei-assistant-form" data-assistant-form><label class="sr-only" for="nei-assistant-input">Ask about a property</label><input id="nei-assistant-input" name="message" maxlength="1200" placeholder="e.g. land for a café, 1 ropani" required /><button type="submit" aria-label="Send question">↗</button></form>`;
  document.body.append(launcher, panel);
  const log = panel.querySelector("[data-assistant-log]"); const form = panel.querySelector("[data-assistant-form]"); const input = form.elements.message; const submit = form.querySelector("button"); const history = [];
  function setOpen(open) { panel.hidden = !open; launcher.hidden = open; launcher.setAttribute("aria-expanded", String(open)); if (open) input.focus(); }
  function message(text, role = "assistant", mode = "") { const node = document.createElement("div"); node.className = `nei-message is-${role}`; node.textContent = text; if (mode) { const status = document.createElement("span"); status.className = "nei-message-status"; status.textContent = mode === "ollama" ? "Analyzed by Ollama using indexed listing facts" : "Database matching mode · Ollama unavailable"; node.append(status); } log.append(node); log.scrollTop = log.scrollHeight; return node; }
  function recommendations(items, filterUrl) {
    if (!items?.length && !filterUrl) return; const wrap = document.createElement("div"); wrap.className = "nei-recommendations";
    (items || []).forEach((item) => { const link = document.createElement("a"); link.className = "nei-recommendation"; link.href = String(item.url || "").startsWith("/properties") ? item.url : "/properties"; const title = document.createElement("strong"); title.textContent = item.title; const meta = document.createElement("span"); meta.textContent = `${item.location} · ${item.area} · ${item.priceLabel}`; const action = document.createElement("em"); action.textContent = "View this match inside the site →"; link.append(title, meta, action); wrap.append(link); });
    if (filterUrl) { const link = document.createElement("a"); link.className = "nei-recommendation"; link.href = String(filterUrl).startsWith("/properties") ? filterUrl : "/properties"; link.innerHTML = "<strong>See all matching results</strong><em>Open the full filtered search →</em>"; wrap.append(link); }
    log.append(wrap); log.scrollTop = log.scrollHeight;
  }
  async function localFallback(userMessage) {
    let payload = null; for (const url of ["/api/listings?limit=250", "/data/listings.json"]) { try { const response = await fetch(url); if (response.ok) { payload = await response.json(); break; } } catch {} }
    const all = payload?.items || []; const lower = userMessage.toLowerCase(); const purpose = /rent|lease/.test(lower) ? "rent" : "buy"; const requestedType = /\bland|plot\b/.test(lower) ? "Land" : /apartment|flat/.test(lower) ? "Apartment" : /house|home/.test(lower) ? "House" : /commercial|cafe|café|shop|office/.test(lower) ? "Commercial" : null;
    const matches = all.filter((item) => item.purpose === purpose && (!requestedType || item.type === requestedType)).slice(0, 3).map((item) => ({ ...item, url: `/properties?purpose=${purpose}&type=${encodeURIComponent(item.type)}&listing=${encodeURIComponent(item.id)}&assistant=1` }));
    return { answer: matches.length ? `I found ${matches.length} close matches in the latest property snapshot. Open a result below to inspect it on the in-site map.` : "I could not find an exact match in the latest snapshot. Try the full property search and broaden one filter.", recommendations: matches, filterUrl: `/properties?purpose=${purpose}${requestedType ? `&type=${encodeURIComponent(requestedType)}` : ""}`, mode: "database-fallback" };
  }
  async function ask(userMessage) {
    try {
      const response = await fetch("/api/assistant/chat", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ message: userMessage, history: history.slice(-6), page: location.pathname + location.search }) });
      if (!response.ok) throw new Error("Assistant endpoint unavailable"); return await response.json();
    } catch { return localFallback(userMessage); }
  }
  async function submitMessage(userMessage) {
    const value = userMessage.trim(); if (!value) return; message(value, "user"); history.push({ role: "user", content: value }); input.value = ""; input.disabled = true; submit.disabled = true; const pending = message("Searching the live index and preparing your analysis…");
    const response = await ask(value); pending.remove(); message(response.answer, "assistant", response.mode); recommendations(response.recommendations, response.filterUrl); history.push({ role: "assistant", content: response.answer }); panel.querySelector("[data-assistant-mode]").textContent = response.mode === "ollama" ? `Ollama · ${response.model || "local model"}` : "Live index matching"; input.disabled = false; submit.disabled = false; input.focus();
  }
  launcher.addEventListener("click", () => setOpen(true)); panel.querySelector("[data-assistant-close]").addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => { event.preventDefault(); submitMessage(input.value); });
  panel.querySelectorAll(".nei-assistant-examples button").forEach((button) => button.addEventListener("click", () => submitMessage(button.textContent)));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) setOpen(false); });
})();
