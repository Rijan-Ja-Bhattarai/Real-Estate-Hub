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
  function assistantContext() {
    const selectedListingIds = [...new Set([...document.querySelectorAll("[data-comparison-id]")].map((node) => node.dataset.comparisonId).filter(Boolean))].slice(0, 4);
    return { selectedListingIds };
  }
  function syncContextLabel() {
    const count = assistantContext().selectedListingIds.length;
    panel.querySelector("[data-assistant-mode]").textContent = count ? `${count} selected Market listing${count === 1 ? "" : "s"} in context` : "Ollama + live listing index";
    input.placeholder = count ? `Ask about the ${count} selected listing${count === 1 ? "" : "s"}` : "e.g. land for a café, 1 ropani";
  }
  function setOpen(open) { panel.hidden = !open; launcher.hidden = open; launcher.setAttribute("aria-expanded", String(open)); if (open) { syncContextLabel(); input.focus(); } }
  function message(text, role = "assistant", mode = "") { const node = document.createElement("div"); node.className = `nei-message is-${role}`; node.textContent = text; if (mode) { const status = document.createElement("span"); status.className = "nei-message-status"; status.textContent = mode === "ollama" ? "Analyzed by Ollama using indexed listing facts" : "Database matching mode · Ollama unavailable"; node.append(status); } log.append(node); log.scrollTop = log.scrollHeight; return node; }
  function recommendations(items, filterUrl, contextMode = "search") {
    if (!items?.length && !filterUrl) return; const wrap = document.createElement("div"); wrap.className = "nei-recommendations";
    (items || []).forEach((item) => { const link = document.createElement("a"); link.className = "nei-recommendation"; link.href = String(item.url || "").startsWith("/properties") ? item.url : "/properties"; const title = document.createElement("strong"); title.textContent = item.title; const meta = document.createElement("span"); meta.textContent = `${item.location} · ${item.area} · ${item.priceLabel}`; const action = document.createElement("em"); action.textContent = item.recommendationRole === "selected-house" ? "Open the recommended house →" : item.recommendationRole === "additional-land" ? "Open the recommended cafe land →" : contextMode === "comparison" ? "Open this selected property →" : "View this match inside the site →"; link.append(title, meta, action); wrap.append(link); });
    if (filterUrl) { const link = document.createElement("a"); link.className = "nei-recommendation"; link.href = String(filterUrl).startsWith("/properties") ? filterUrl : "/properties"; link.innerHTML = "<strong>See all matching results</strong><em>Open the full filtered search →</em>"; wrap.append(link); }
    log.append(wrap); log.scrollTop = log.scrollHeight;
  }
  async function localFallback(userMessage) {
    let payload = null; for (const url of ["/api/listings?limit=250", "/data/listings.json"]) { try { const response = await fetch(url); if (response.ok) { payload = await response.json(); break; } } catch {} }
    const all = payload?.items || []; const context = assistantContext();
    if (context.selectedListingIds.length) {
      const byId = new Map(all.map((item) => [String(item.id), item]));
      const selected = context.selectedListingIds.map((id) => byId.get(id)).filter(Boolean);
      const recommendations = selected.map((item) => ({ ...item, reason: "Pinned in your Market comparison.", url: `/properties?purpose=${encodeURIComponent(item.purpose || "buy")}&type=${encodeURIComponent(item.type || "")}&listing=${encodeURIComponent(item.id)}&assistant=1` }));
      const lower = userMessage.toLowerCase();
      const wantsOne = /\b(best|choose|pick|recommend|winner)\b/.test(lower) || /\bwhich\b.{0,45}\b(buy|purchase|better|value|one)\b/.test(lower) || /\bwhat\b.{0,30}\bshould\s+i\s+buy\b/.test(lower);
      const wantsLandToo = /\b(land|plot)\b/.test(lower) && /\b(cafe|cafÃ©|restaurant|shop)\b/.test(lower);
      if (wantsOne && selected.length) {
        const budgetMatch = lower.match(/(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac)\b/);
        const budget = budgetMatch ? Number(budgetMatch[1]) * (/crore|cr/.test(budgetMatch[2]) ? 10000000 : 100000) : null;
        const fact = (item, ...keys) => keys.map((key) => item.facts?.[key]).find(Boolean);
        const score = (item) => {
          let points = 0; const price = Number(item.price);
          if (budget && Number.isFinite(price)) points += price <= budget ? 50 : -100 * ((price - budget) / budget + 1);
          if (fact(item, "road_access", "road_and_area")) points += 8;
          if (fact(item, "facing")) points += 4;
          if (fact(item, "parking")) points += 4;
          if (item.area && String(item.area).toLowerCase() !== "area on source") points += 2;
          return points;
        };
        const winner = selected.reduce((best, item) => score(item) > score(best) ? item : best);
        const winnerRecommendation = recommendations.find((item) => String(item.id) === String(winner.id));
        const reasons = [];
        if (budget && Number(winner.price) <= budget) reasons.push(`its ${winner.priceLabel || "reported price"} is within your budget`);
        const road = fact(winner, "road_access", "road_and_area");
        if (road) reasons.push(`it reports ${road} road access`);
        const facing = fact(winner, "facing");
        if (facing && reasons.length < 2) reasons.push(`it reports ${facing} facing`);
        if (!reasons.length) reasons.push("it has the strongest combination of price and available property details in your shortlist");
        if (wantsLandToo) {
          const landScore = (item) => { const road = String(fact(item, "road_access", "road_and_area") || ""); return (road && !/^\d+(?:\.\d+)?$/.test(road) ? 8 : 0) + (item.area && String(item.area).toLowerCase() !== "area on source" ? 3 : 0) + (/cafe|commercial|main road|highway/.test(String(item.description || "").toLowerCase()) ? 5 : 0); };
          const land = all.filter((item) => item.purpose === "buy" && item.type === "Land" && !context.selectedListingIds.includes(String(item.id))).sort((left, right) => landScore(right) - landScore(left))[0];
          const landRecommendation = land ? { ...land, recommendationRole: "additional-land", reason: "Closest cafe-land match in the indexed inventory.", url: `/properties?purpose=buy&type=Land&listing=${encodeURIComponent(land.id)}&assistant=1` } : null;
          const houseRecommendation = winnerRecommendation ? { ...winnerRecommendation, recommendationRole: "selected-house" } : null;
          const houseAnswer = `For the house, the strongest fit is ${winner.title} because ${reasons.slice(0, 2).join(" and ")}.`;
          const landAnswer = land ? `For the cafe, the strongest land match is ${land.title} because it has the best available access and size details in the current index.` : "I could not find an indexed cafe-land match yet, so broaden the land filters.";
          return { answer: `${houseAnswer} ${landAnswer}`, recommendations: [houseRecommendation, landRecommendation].filter(Boolean), filterUrl: null, contextMode: "compound", responseStyle: "compound-recommendation", selectedListingIds: selected.map((item) => String(item.id)), mode: "database-fallback" };
        }
        return { answer: `The strongest fit among your selected listings is ${winner.title} because ${reasons.slice(0, 2).join(" and ")}. Prioritize this one for verification before making an offer.`, recommendations: winnerRecommendation ? [winnerRecommendation] : [], filterUrl: null, contextMode: "comparison", responseStyle: "single-recommendation", selectedListingIds: selected.map((item) => String(item.id)), mode: "database-fallback" };
      }
      const prefix = `I’m using only your ${selected.length} selected Market listing${selected.length === 1 ? "" : "s"}. `;
      const detail = /road|access|vehicle/.test(lower)
        ? selected.map((item) => `${item.title}: ${item.facts?.road_access || item.facts?.road_and_area || "road access not supplied"}`).join("; ")
        : /area|size|space|ropani|aana|land/.test(lower)
          ? selected.map((item) => `${item.title}: ${item.area || "area not supplied"}`).join("; ")
          : selected.map((item) => `${item.title}: ${item.priceLabel || "price on request"}, ${item.area || "area not supplied"}`).join("; ");
      return { answer: selected.length ? `${prefix}${detail}.` : "I could not reload the selected listings. Re-select them on the Market page and ask again.", recommendations, filterUrl: null, contextMode: "comparison", selectedListingIds: selected.map((item) => String(item.id)), mode: "database-fallback" };
    }
    const lower = userMessage.toLowerCase(); const purpose = /rent|lease/.test(lower) ? "rent" : "buy"; const requestedType = /\bland|plot\b/.test(lower) ? "Land" : /apartment|flat/.test(lower) ? "Apartment" : /house|home/.test(lower) ? "House" : /commercial|cafe|café|shop|office/.test(lower) ? "Commercial" : null;
    const matches = all.filter((item) => item.purpose === purpose && (!requestedType || item.type === requestedType)).slice(0, 3).map((item) => ({ ...item, url: `/properties?purpose=${purpose}&type=${encodeURIComponent(item.type)}&listing=${encodeURIComponent(item.id)}&assistant=1` }));
    return { answer: matches.length ? `I found ${matches.length} close matches in the latest property snapshot. Open a result below to inspect it on the in-site map.` : "I could not find an exact match in the latest snapshot. Try the full property search and broaden one filter.", recommendations: matches, filterUrl: `/properties?purpose=${purpose}${requestedType ? `&type=${encodeURIComponent(requestedType)}` : ""}`, contextMode: "search", selectedListingIds: [], mode: "database-fallback" };
  }
  async function ask(userMessage) {
    try {
      const context = assistantContext();
      const response = await fetch("/api/assistant/chat", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ message: userMessage, history: history.slice(0, -1).slice(-6), page: location.pathname + location.search, selectedListingIds: context.selectedListingIds }) });
      if (!response.ok) throw new Error("Assistant endpoint unavailable");
      const result = await response.json();
      if (context.selectedListingIds.length) {
        const returnedIds = Array.isArray(result.selectedListingIds) ? result.selectedListingIds.map(String) : [];
        const exactContext = returnedIds.length === context.selectedListingIds.length && returnedIds.every((id, index) => id === context.selectedListingIds[index]);
        if (!["comparison", "compound"].includes(result.contextMode) || !exactContext) throw new Error("Assistant server ignored the selected comparison");
      }
      return result;
    } catch { return localFallback(userMessage); }
  }
  async function submitMessage(userMessage) {
    const value = userMessage.trim(); if (!value) return; message(value, "user"); history.push({ role: "user", content: value }); input.value = ""; input.disabled = true; submit.disabled = true; const pending = message("Searching the live index and preparing your analysis…");
    const response = await ask(value); pending.remove(); message(response.answer, "assistant", response.mode); recommendations(response.recommendations, response.filterUrl, response.contextMode); history.push({ role: "assistant", content: response.answer }); const selectedCount = response.selectedListingIds?.length || 0; panel.querySelector("[data-assistant-mode]").textContent = response.mode === "ollama" ? `Ollama · ${response.model || "local model"}${selectedCount ? ` · ${selectedCount} selected` : ""}` : selectedCount ? `Database comparison · ${selectedCount} selected` : "Live index matching"; input.disabled = false; submit.disabled = false; input.focus();
  }
  launcher.addEventListener("click", () => setOpen(true)); panel.querySelector("[data-assistant-close]").addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => { event.preventDefault(); submitMessage(input.value); });
  panel.querySelectorAll(".nei-assistant-examples button").forEach((button) => button.addEventListener("click", () => submitMessage(button.textContent)));
  document.addEventListener("nei:comparison-change", syncContextLabel);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) setOpen(false); });
})();
