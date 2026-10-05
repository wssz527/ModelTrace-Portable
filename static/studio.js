/* ModelTrace 自动化测试台前端逻辑（提供商持久化 + 渐进单测 + 多轮稳定性 + 一致性阻断） */
(function () {
  "use strict";

  var CONVERGE_P = 0.95;
  var BLOCK_P = 0.8;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function api(path, body, method) {
    if (window.ModelTracePortable) { return window.ModelTracePortable.api(path, body, method); }
    var options = { method: method || "POST", headers: { "Content-Type": "application/json" } };
    if (method === "GET" || method === "DELETE") { delete options.headers["Content-Type"]; }
    if (body !== undefined && method !== "GET") { options.body = JSON.stringify(body); }
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { throw new Error(data.error || ("HTTP " + res.status)); }
        return data;
      });
    });
  }

  function showMessage(el, type, text) {
    el.hidden = false;
    el.className = "message " + type;
    el.textContent = text;
  }

  function hideMessage(el) { el.hidden = true; }

  function fmtTime(iso) {
    if (!iso) { return "—"; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return "—"; }
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ---------- 期望模型一致性匹配 ---------- */

  function normModel(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function modelVariants(s) {
    var lower = (s || "").toLowerCase();
    var variants = [normModel(lower)];
    var stripped = lower.split("/").pop();
    while (/^(?:by|a6api|agent|cpa)-/.test(stripped)) {
      stripped = stripped.replace(/^(?:by|a6api|agent|cpa)-/, "");
    }
    variants.push(normModel(stripped));
    return variants.filter(function (v) { return !!v; });
  }

  /* 请求模型名与指纹库模型 ID 是否指向同一模型（处理 by-/a6api-/agent- 等渠道前缀）。
     返回 true / false / null（无法判断）。 */
  function modelMatches(requested, prediction) {
    var reqV = modelVariants(requested);
    var predV = modelVariants(prediction);
    if (!reqV.length || !predV.length) { return null; }
    for (var i = 0; i < reqV.length; i += 1) {
      for (var j = 0; j < predV.length; j += 1) {
        if (reqV[i] === predV[j]) { return true; }
      }
    }
    return false;
  }

  function requestedInBank(requested, results) {
    return (results || []).some(function (item) { return modelMatches(requested, item.model) === true; });
  }

  /* ---------- 工作区与模式切换 ---------- */

  $$(".nav-button").forEach(function (button) {
    button.addEventListener("click", function () {
      $$(".nav-button").forEach(function (b) { b.classList.toggle("active", b === button); });
      $$(".workspace").forEach(function (w) { w.classList.toggle("active", w.id === "workspace-" + button.dataset.workspace); });
      if (button.dataset.workspace === "library" && !window.ModelTracePortable) { loadGitStatus(); loadBankInventory(); }
    });
  });

  $$("[data-test-mode]").forEach(function (tab) {
    tab.addEventListener("click", function () {
      $$("[data-test-mode]").forEach(function (t) { t.classList.toggle("active", t === tab); });
      $$("#workspace-test .mode-panel").forEach(function (p) { p.classList.remove("active"); });
      $("#test-" + tab.dataset.testMode).classList.add("active");
    });
  });

  /* ---------- 测试状态清理（换渠道 / 换模型 / 重新拉取时调用） ---------- */

  var cardsContainer = $("#test-cards");
  var stabilityContainer = $("#stability-cards");
  var cards = {};
  var stabilityCards = {};

  function clearAllTestState() {
    Object.keys(cards).forEach(function (m) { cards[m].disposed = true; cards[m].el.remove(); delete cards[m]; });
    Object.keys(stabilityCards).forEach(function (m) {
      stabilityCards[m].stopRequested = true;
      stabilityCards[m].el.remove();
      delete stabilityCards[m];
    });
    var manualResult = $("#manual-result");
    manualResult.hidden = true;
    manualResult.innerHTML = "";
    $$("[data-manual-output]").forEach(function (area) { area.value = ""; });
    selectedSet = {};
    fetchedModels = [];
    renderChecklist("");
  }

  /* ---------- 提供商持久化 ---------- */

  var providerSelect = $("#provider-select");
  var connBase = $("#conn-base");
  var connKey = $("#conn-key");
  var providers = [];

  function renderProviderOptions(selectedId) {
    providerSelect.innerHTML = '<option value="">自定义（临时填写）</option>';
    providers.forEach(function (p) {
      var option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.name;
      providerSelect.appendChild(option);
    });
    if (selectedId) { providerSelect.value = selectedId; }
    $("#provider-delete").hidden = !providerSelect.value;
  }

  function loadProviders(preferId) {
    return api("/api/providers", undefined, "GET").then(function (data) {
      providers = data.providers || [];
      var saved = preferId;
      if (!saved) {
        try { saved = localStorage.getItem("mt_provider_id") || ""; } catch (e) { saved = ""; }
      }
      var exists = saved && providers.some(function (p) { return p.id === saved; });
      renderProviderOptions(exists ? saved : "");
      if (exists) { applyProvider(saved); }
    }).catch(function () { /* 首次无提供商可忽略 */ });
  }

  function applyProvider(id) {
    var p = providers.find(function (item) { return item.id === id; });
    if (!p) { return; }
    connBase.value = p.base_url;
    connKey.value = p.api_key;
    $("#provider-delete").hidden = false;
    try { localStorage.setItem("mt_provider_id", id); localStorage.setItem("mt_base_url", p.base_url); } catch (e) { /* 忽略 */ }
  }

  providerSelect.addEventListener("change", function () {
    var id = providerSelect.value;
    $("#provider-delete").hidden = !id;
    clearAllTestState();
    if (id) { applyProvider(id); }
    else { connKey.value = ""; }
  });

  connBase.addEventListener("change", clearAllTestState);
  connKey.addEventListener("change", clearAllTestState);
  window.addEventListener("modeltrace-bank-changed", clearAllTestState);
  window.addEventListener("modeltrace-connection-changed", clearAllTestState);
  ["#conn-route", "#bridge-url", "#conn-format"].forEach(function (selector) {
    if ($(selector)) { $(selector).addEventListener("change", clearAllTestState); }
  });

  $("#provider-save").addEventListener("click", function () {
    var row = $("#provider-save-row");
    row.hidden = !row.hidden;
    if (!row.hidden && !$("#provider-name").value) {
      var selected = providerSelect.value ? providers.find(function (p) { return p.id === providerSelect.value; }) : null;
      if (selected) {
        $("#provider-name").value = selected.name;
      } else {
        try {
          $("#provider-name").value = new URL(connBase.value).hostname;
        } catch (e) {
          $("#provider-name").value = "";
        }
      }
    }
  });

  $("#provider-save-cancel").addEventListener("click", function () {
    $("#provider-save-row").hidden = true;
  });

  $("#provider-save-confirm").addEventListener("click", function () {
    var name = $("#provider-name").value.trim();
    if (!name) { showMessage(testMessage, "error", "请填写提供商名称"); return; }
    if (!connBase.value.trim() || !connKey.value) { showMessage(testMessage, "error", "请先填写 Base URL 和 API Key"); return; }
    var existing = providerSelect.value ? providers.find(function (p) { return p.id === providerSelect.value; }) : null;
    var body = { name: name, base_url: connBase.value.trim(), api_key: connKey.value };
    if (existing && existing.name === name) { body.id = existing.id; }
    api("/api/providers", body).then(function (data) {
      providers = data.providers || [];
      var saved = providers.find(function (p) { return p.name === name; });
      renderProviderOptions(saved ? saved.id : "");
      if (saved) { applyProvider(saved.id); }
      $("#provider-save-row").hidden = true;
      showMessage(testMessage, "success", "提供商「" + name + "」已保存，下次直接选用");
    }).catch(function (error) {
      showMessage(testMessage, "error", "保存失败：" + error.message);
    });
  });

  $("#provider-delete").addEventListener("click", function () {
    var id = providerSelect.value;
    var p = providers.find(function (item) { return item.id === id; });
    if (!p) { return; }
    if (!window.confirm("确定删除提供商「" + p.name + "」？")) { return; }
    api("/api/providers/" + encodeURIComponent(id), undefined, "DELETE").then(function (data) {
      providers = data.providers || [];
      renderProviderOptions("");
      try { localStorage.removeItem("mt_provider_id"); } catch (e) { /* 忽略 */ }
      clearAllTestState();
      showMessage(testMessage, "success", "已删除提供商「" + p.name + "」");
    }).catch(function (error) {
      showMessage(testMessage, "error", "删除失败：" + error.message);
    });
  });

  /* ---------- 连接与模型拉取 ---------- */

  var testMessage = $("#test-message");
  try { connBase.value = localStorage.getItem("mt_base_url") || ""; } catch (e) { connBase.value = ""; }

  function connInfo() {
    var temperature = $("#conn-temperature").value;
    return {
      base_url: connBase.value.trim(),
      api_key: connKey.value,
      temperature: temperature === "" ? null : Number(temperature),
      thinking: $("#conn-thinking").value || null,
      api_format: $("#conn-format") ? $("#conn-format").value : "auto",
      route: $("#conn-route") ? $("#conn-route").value : "auto",
      bridge_url: $("#bridge-url") ? $("#bridge-url").value : ""
    };
  }

  function selectedModels() {
    return Object.keys(selectedSet);
  }

  function requireConnAndSelection() {
    var conn = connInfo();
    if (!conn.base_url || !conn.api_key) {
      showMessage(testMessage, "error", "请先填写 Base URL 和 API Key（或选择已保存的提供商）");
      return null;
    }
    var selected = selectedModels();
    if (!selected.length) {
      showMessage(testMessage, "error", "请先勾选要测试的模型");
      return null;
    }
    hideMessage(testMessage);
    return { conn: conn, models: selected };
  }

  var fetchedModels = [];
  var selectedSet = {};
  var picker = $("#model-picker");
  var checklist = $("#model-checklist");

  /* 分隔符无关匹配：忽略 - . _ 与空格，"5.5"/"5 5"/"55" 都能命中 opus-5-5 */
  function normFilterText(s) {
    return (s || "").toLowerCase().replace(/[\s.\-_]/g, "");
  }

  function renderChecklist(filter) {
    var keyword = normFilterText(filter);
    checklist.innerHTML = "";
    fetchedModels.forEach(function (model) {
      if (keyword && normFilterText(model).indexOf(keyword) === -1) { return; }
      var label = document.createElement("label");
      label.className = "model-check-item" + (selectedSet[model] ? " checked" : "");
      label.innerHTML = '<input type="checkbox" value="' + esc(model) + '"' + (selectedSet[model] ? " checked" : "") + '><span>' + esc(model) + "</span>";
      var input = label.querySelector("input");
      input.addEventListener("change", function () {
        if (input.checked) { selectedSet[model] = true; } else { delete selectedSet[model]; }
        label.classList.toggle("checked", input.checked);
        updatePickerCount();
      });
      checklist.appendChild(label);
    });
    updatePickerCount();
  }

  function updatePickerCount() {
    var checked = Object.keys(selectedSet).length;
    var visible = $$("input[type=checkbox]", checklist).length;
    $("#picker-count").textContent = "已选 " + checked + " / 显示 " + visible + " / 共 " + fetchedModels.length;
  }

  $("#conn-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var conn = connInfo();
    if (!conn.base_url || !conn.api_key) { showMessage(testMessage, "error", "请填写 Base URL 和 API Key"); return; }
    try { localStorage.setItem("mt_base_url", conn.base_url); } catch (e) { /* 忽略 */ }
    clearAllTestState();
    var button = $("#conn-form button[type=submit]");
    button.disabled = true;
    showMessage(testMessage, "working", "正在拉取模型列表…");
    api("/api/models/list", conn).then(function (data) {
      fetchedModels = data.models || [];
      picker.hidden = false;
      renderChecklist("");
      $("#model-filter").value = "";
      showMessage(testMessage, "success", "拉取成功，共 " + fetchedModels.length + " 个模型，勾选后在下方选择测试模式");
    }).catch(function (error) {
      picker.hidden = false;
      showMessage(testMessage, "error", "拉取失败：" + error.message);
    }).finally(function () { button.disabled = false; });
  });

  $("#model-filter").addEventListener("input", function () { renderChecklist(this.value); });
  $("#picker-all").addEventListener("click", function () {
    $$("input[type=checkbox]", checklist).forEach(function (c) { c.checked = true; selectedSet[c.value] = true; c.closest(".model-check-item").classList.add("checked"); });
    updatePickerCount();
  });
  $("#picker-none").addEventListener("click", function () {
    selectedSet = {};
    $$("input[type=checkbox]", checklist).forEach(function (c) { c.checked = false; c.closest(".model-check-item").classList.remove("checked"); });
    updatePickerCount();
  });
  $("#manual-model-add").addEventListener("click", function () {
    var input = $("#manual-model-name");
    var name = input.value.trim();
    if (!name) { return; }
    if (fetchedModels.indexOf(name) === -1) { fetchedModels.push(name); fetchedModels.sort(); }
    input.value = "";
    selectedSet[name] = true;
    renderChecklist($("#model-filter").value);
  });

  /* ---------- 渐进单测卡片 ---------- */

  function pruneCards(selection) {
    Object.keys(cards).forEach(function (m) {
      if (selection.indexOf(m) === -1) { cards[m].el.remove(); delete cards[m]; }
    });
    Object.keys(stabilityCards).forEach(function (m) {
      if (selection.indexOf(m) === -1) {
        stabilityCards[m].stopRequested = true;
        stabilityCards[m].el.remove();
        delete stabilityCards[m];
      }
    });
  }

  $("#start-tests").addEventListener("click", function () {
    var ready = requireConnAndSelection();
    if (!ready) { return; }
    pruneCards(ready.models);
    var added = 0;
    ready.models.forEach(function (model) {
      if (!cards[model]) { createCard(model); added += 1; }
    });
    if (!added) { showMessage(testMessage, "success", "所选模型都已在测试列表中"); }
    cardsContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  function createCard(model) {
    var card = { model: model, conn: connInfo(), rounds: [null, null, null], result: null, busy: false, autoRunning: false, blocked: false, disposed: false };
    var el = document.createElement("div");
    el.className = "test-card";
    el.innerHTML =
      '<div class="test-card-head">' +
      '  <strong class="test-card-model" title="' + esc(model) + '">' + esc(model) + "</strong>" +
      '  <span class="converge-badge" hidden></span>' +
      '  <span class="spacer"></span>' +
      '  <button class="button secondary card-reset" type="button">重置</button>' +
      '  <button class="button secondary auto-run" type="button">自动跑到收敛</button>' +
      '  <button class="card-remove" type="button" title="移除">×</button>' +
      "</div>" +
      '<div class="round-list"></div>' +
      '<div class="card-result" hidden></div>';
    var roundList = el.querySelector(".round-list");
    for (var i = 0; i < 3; i += 1) {
      var row = document.createElement("div");
      row.className = "round-row";
      row.innerHTML =
        '<label class="round-check"><input type="checkbox" data-round="' + i + '"><span>第 ' + (i + 1) + " 轮</span></label>" +
        '<span class="round-state">等待</span>' +
        '<button class="round-detail" type="button" hidden>提示词与回答</button>';
      roundList.appendChild(row);
      var io = document.createElement("div");
      io.className = "round-io";
      io.hidden = true;
      io.innerHTML =
        "<div><div class=\"round-io-label\">提示词（每轮自动生成，重置后再跑会换新题）</div><pre class=\"io-prompt\"></pre></div>" +
        "<div><div class=\"round-io-label\">模型回答</div><pre class=\"io-text\"></pre></div>";
      roundList.appendChild(io);
    }
    card.el = el;
    cards[model] = card;
    cardsContainer.appendChild(el);

    $$("input[type=checkbox]", el).forEach(function (box) {
      box.addEventListener("change", function () {
        var idx = Number(box.dataset.round);
        if (box.checked) { runRound(card, idx); } else { clearRound(card, idx); }
      });
    });
    $$(".round-detail", el).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var io = btn.closest(".round-row").nextElementSibling;
        io.hidden = !io.hidden;
        btn.textContent = io.hidden ? "提示词与回答" : "收起";
      });
    });
    el.querySelector(".card-remove").addEventListener("click", function () {
      card.disposed = true;
      delete cards[model];
      el.remove();
    });
    el.querySelector(".card-reset").addEventListener("click", function () {
      clearRound(card, 0);
    });
    el.querySelector(".auto-run").addEventListener("click", function () { autoRun(card); });
    updateRoundAvailability(card);
  }

  function roundRow(card, idx) { return $$(".round-row", card.el)[idx]; }
  function roundIO(card, idx) { return $$(".round-io", card.el)[idx]; }

  function setRoundState(card, idx, cls, text) {
    var state = roundRow(card, idx).querySelector(".round-state");
    state.className = "round-state" + (cls ? " " + cls : "");
    state.textContent = text;
  }

  function updateRoundAvailability(card) {
    $$("input[type=checkbox]", card.el).forEach(function (box) {
      var idx = Number(box.dataset.round);
      var ready = true;
      for (var j = 0; j < idx; j += 1) {
        if (!card.rounds[j] || !card.rounds[j].accepted) { ready = false; break; }
      }
      box.disabled = card.busy || !ready;
      box.closest(".round-check").classList.toggle("disabled", box.disabled);
    });
  }

  function setCardBusy(card, busy) {
    card.busy = busy;
    card.el.querySelector(".auto-run").disabled = busy;
    card.el.querySelector(".card-reset").disabled = busy;
    updateRoundAvailability(card);
  }

  function fillRoundResult(card, idx, data) {
    card.rounds[idx] = data;
    var row = roundRow(card, idx);
    row.querySelector(".round-detail").hidden = false;
    var io = roundIO(card, idx);
    io.querySelector(".io-prompt").textContent = data.prompt || "";
    io.querySelector(".io-text").textContent = data.text || "";
    if (data.accepted) {
      setRoundState(card, idx, "done", "✓ 解析 " + data.parsed_count + " 个数字");
    } else {
      setRoundState(card, idx, "invalid", "✗ 有效数字不足 " + data.parsed_count + "/" + data.minimum + "（不计入，可重试）");
    }
  }

  function runRound(card, idx) {
    if (card.busy) { return; }
    setCardBusy(card, true);
    setRoundState(card, idx, "running", "请求中…");
    var conn = card.conn;
    api("/api/test/round", {
      base_url: conn.base_url,
      api_key: conn.api_key,
      api_model: card.model,
      temperature: conn.temperature,
      thinking: conn.thinking, api_format: conn.api_format, route: conn.route, bridge_url: conn.bridge_url
    }).then(function (data) {
      if (card.disposed) { return; }
      fillRoundResult(card, idx, data);
      return recompute(card);
    }).catch(function (error) {
      card.rounds[idx] = null;
      setRoundState(card, idx, "error", "✗ " + error.message);
      roundRow(card, idx).querySelector("input[type=checkbox]").checked = false;
    }).finally(function () {
      setCardBusy(card, false);
      updateRoundAvailability(card);
    });
  }

  function clearRound(card, idx) {
    card.blocked = false;
    for (var i = idx; i < 3; i += 1) {
      card.rounds[i] = null;
      var row = roundRow(card, i);
      row.querySelector("input[type=checkbox]").checked = false;
      row.querySelector(".round-detail").hidden = true;
      roundIO(card, i).hidden = true;
      setRoundState(card, i, "", "等待");
    }
    card.result = null;
    recompute(card);
    updateRoundAvailability(card);
  }

  function acceptedOutputs(card) {
    var outputs = [];
    for (var i = 0; i < 3; i += 1) {
      if (card.rounds[i] && card.rounds[i].accepted) {
        outputs.push({ text: card.rounds[i].text, expected_count: card.rounds[i].expected_count });
      }
    }
    return outputs;
  }

  function recompute(card) {
    var outputs = acceptedOutputs(card);
    var resultEl = card.el.querySelector(".card-result");
    if (!outputs.length) {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
      updateBadge(card, null);
      return Promise.resolve();
    }
    return api("/api/analyze", { outputs: outputs }).then(function (result) {
      card.result = result;
      renderCardResult(card, result);
      updateBadge(card, result);
    }).catch(function (error) {
      resultEl.hidden = false;
      resultEl.innerHTML = '<div class="card-result-summary"><span class="pred-meta">计算失败：' + esc(error.message) + "</span></div>";
    });
  }

  function converged(card) {
    return !!(card.result && card.result.probability >= CONVERGE_P);
  }

  function updateBadge(card, result) {
    var badge = card.el.querySelector(".converge-badge");
    if (!result) { badge.hidden = true; card.blocked = false; return; }
    badge.hidden = false;
    var match = requestedInBank(card.model, result.results) ? modelMatches(card.model, result.prediction) : null;
    card.blocked = match === false && result.probability >= BLOCK_P && result.probability < CONVERGE_P;
    if (result.probability >= CONVERGE_P) {
      if (match === false) {
        badge.className = "converge-badge exhausted";
        badge.textContent = "已收敛 · ✗ 指纹更接近 " + result.prediction;
      } else if (match === true) {
        badge.className = "converge-badge ok";
        badge.textContent = "已收敛 · ✓ 与请求模型一致";
      } else {
        badge.className = "converge-badge ok";
        badge.textContent = "已收敛 · 可停止";
      }
    } else if (card.blocked) {
      badge.className = "converge-badge exhausted";
      badge.textContent = "疑似不一致（" + (result.probability * 100).toFixed(0) + "% 指向 " + result.prediction + "）· 已阻断";
    } else if (acceptedOutputs(card).length >= 3) {
      badge.className = "converge-badge exhausted";
      badge.textContent = "三轮已用完 · 未收敛";
    } else {
      badge.className = "converge-badge pending";
      badge.textContent = "未收敛 · 建议下一轮";
    }
  }

  function renderCardResult(card, result) {
    var resultEl = card.el.querySelector(".card-result");
    resultEl.hidden = false;
    var match = requestedInBank(card.model, result.results) ? modelMatches(card.model, result.prediction) : null;
    var matchTag = match === true
      ? '<span class="match-tag ok">✓ 与请求模型一致</span>'
      : (match === false ? '<span class="match-tag bad">✗ 与声明模型指纹不一致</span>' : "");
    var top = result.results.slice(0, 5).map(function (item, index) {
      var pct = item.probability * 100;
      return '<div class="card-top-item' + (index === 0 ? " winner" : "") + '">' +
        '<span class="name" title="' + esc(item.model) + '">' + esc(item.model) + "</span>" +
        '<span class="bar"><i style="width:' + Math.max(0.5, pct).toFixed(1) + '%"></i></span>' +
        '<span class="pct">' + pct.toFixed(1) + "%</span></div>";
    }).join("");
    var hint = requestedInBank(card.model, result.results)
      ? ""
      : '<div class="card-hint">⚠ 请求的模型「' + esc(card.model) + '」不在指纹库候选中：闭集归因会归到最相似的候选，以上结果无法判断该渠道是否与所声明模型一致。</div>';
    resultEl.innerHTML =
      '<div class="card-result-summary">' +
      '  <span class="pred-name">' + esc(result.prediction_name || result.prediction) + "</span>" +
      '  <span class="pred-prob">' + (result.probability * 100).toFixed(2) + "%</span>" +
      matchTag +
      '  <span class="pred-meta">已用 ' + result.used_outputs + " 轮 · " + esc(result.family_prediction_name) +
      " 家族 " + (result.family_probability * 100).toFixed(1) + "%</span>" +
      "</div>" +
      '<div class="card-top-list">' + top + "</div>" +
      hint;
  }

  function autoRun(card) {
    if (card.busy || card.autoRunning) { return; }
    card.autoRunning = true;
    card.el.querySelector(".auto-run").disabled = true;
    var finish = function () {
      card.autoRunning = false;
      card.el.querySelector(".auto-run").disabled = false;
      updateRoundAvailability(card);
    };
    var step = function (idx) {
      if (card.disposed || idx >= 3 || converged(card) || card.blocked) { finish(); return; }
      var box = roundRow(card, idx).querySelector("input[type=checkbox]");
      box.checked = true;
      setCardBusy(card, true);
      setRoundState(card, idx, "running", "请求中…");
      var conn = card.conn;
      api("/api/test/round", {
        base_url: conn.base_url,
        api_key: conn.api_key,
        api_model: card.model,
        temperature: conn.temperature,
        thinking: conn.thinking, api_format: conn.api_format, route: conn.route, bridge_url: conn.bridge_url
      }).then(function (data) {
        if (card.disposed) { finish(); return; }
        fillRoundResult(card, idx, data);
        if (!data.accepted) { box.checked = false; setCardBusy(card, false); finish(); return; }
        return recompute(card).then(function () { setCardBusy(card, false); step(idx + 1); });
      }).catch(function (error) {
        card.rounds[idx] = null;
        setRoundState(card, idx, "error", "✗ " + error.message);
        box.checked = false;
        setCardBusy(card, false);
        finish();
      });
    };
    step(0);
  }

  /* ---------- 多轮稳定性测试 ---------- */

  function pruneStability(selection) {
    Object.keys(stabilityCards).forEach(function (m) {
      if (selection.indexOf(m) === -1) {
        stabilityCards[m].stopRequested = true;
        stabilityCards[m].el.remove();
        delete stabilityCards[m];
      }
    });
  }

  $("#start-stability").addEventListener("click", function () {
    var ready = requireConnAndSelection();
    if (!ready) { return; }
    var total = Math.min(20, Math.max(2, Number($("#stability-rounds").value) || 5));
    pruneStability(ready.models);
    ready.models.forEach(function (model) {
      if (stabilityCards[model] && stabilityCards[model].running) { return; }
      createStabilityCard(model, total);
      runStability(stabilityCards[model]);
    });
  });

  function createStabilityCard(model, total) {
    if (stabilityCards[model]) { stabilityCards[model].el.remove(); }
    var card = { model: model, conn: connInfo(), total: total, rounds: [], running: false, stopRequested: false, blocked: false };
    var el = document.createElement("div");
    el.className = "test-card stability-card";
    el.innerHTML =
      '<div class="test-card-head">' +
      '  <strong class="test-card-model" title="' + esc(model) + '">' + esc(model) + "</strong>" +
      '  <span class="converge-badge" hidden></span>' +
      '  <span class="spacer"></span>' +
      '  <button class="button secondary stability-stop" type="button">停止</button>' +
      '  <button class="card-remove" type="button" title="移除">×</button>' +
      "</div>" +
      '<div class="stability-rounds"></div>' +
      '<div class="stability-summary" hidden></div>';
    var roundsEl = el.querySelector(".stability-rounds");
    for (var i = 0; i < total; i += 1) {
      var slot = document.createElement("div");
      slot.className = "stability-slot";
      slot.innerHTML = '<span class="slot-idx">' + (i + 1) + '</span><span class="slot-state">等待</span><span class="slot-pred"></span>';
      roundsEl.appendChild(slot);
    }
    card.el = el;
    stabilityCards[model] = card;
    stabilityContainer.appendChild(el);
    el.querySelector(".stability-stop").addEventListener("click", function () {
      card.stopRequested = true;
      el.querySelector(".stability-stop").disabled = true;
    });
    el.querySelector(".card-remove").addEventListener("click", function () {
      card.stopRequested = true;
      delete stabilityCards[model];
      el.remove();
    });
  }

  function stabilitySlot(card, idx) { return $$(".stability-slot", card.el)[idx]; }

  function runOneAttribution(card) {
    var conn = card.conn;
    var outputs = [];
    var lastError = null;
    var result = null;
    var attempt = function (n) {
      if (card.stopRequested || n >= 3) { return Promise.resolve(); }
      return api("/api/test/round", {
        base_url: conn.base_url,
        api_key: conn.api_key,
        api_model: card.model,
        temperature: conn.temperature,
        thinking: conn.thinking, api_format: conn.api_format, route: conn.route, bridge_url: conn.bridge_url
      }).then(function (data) {
        if (data.accepted) {
          outputs.push({ text: data.text, expected_count: data.expected_count });
        } else {
          lastError = "有效数字不足 " + data.parsed_count + "/" + data.minimum;
        }
        if (!outputs.length) { return attempt(n + 1); }
        return api("/api/analyze", { outputs: outputs }).then(function (res) {
          result = res;
          var mismatch = requestedInBank(card.model, res.results) && modelMatches(card.model, res.prediction) === false && res.probability >= BLOCK_P;
          if (res.probability >= CONVERGE_P || mismatch) { return; }
          return attempt(n + 1);
        });
      }).catch(function (error) {
        lastError = error.message;
        return;
      });
    };
    return attempt(0).then(function () {
      return {
        converged: !!(result && result.probability >= CONVERGE_P),
        known: !!(result && requestedInBank(card.model, result.results)),
        prediction: result ? result.prediction : null,
        probability: result ? result.probability : 0,
        used: outputs.length,
        error: outputs.length ? null : lastError
      };
    });
  }

  function runStability(card) {
    card.running = true;
    card.doneCount = 0;
    var finishIfDone = function () {
      if (card.doneCount >= card.total) {
        card.running = false;
        renderStabilityVerdict(card);
      }
    };
    var launch = function (idx) {
      var slot = stabilitySlot(card, idx);
      slot.classList.add("running");
      slot.querySelector(".slot-state").textContent = "归因中…";
      runOneAttribution(card).then(function (res) {
        card.rounds[idx] = res;
        card.doneCount += 1;
        slot.classList.remove("running");
        var mismatch = res.known && res.prediction && modelMatches(card.model, res.prediction) === false && res.probability >= BLOCK_P;
        if (mismatch) {
          slot.classList.add("fail");
          slot.querySelector(".slot-state").textContent = "✗ 不一致";
          slot.querySelector(".slot-pred").textContent = res.prediction + " " + (res.probability * 100).toFixed(1) + "%";
        } else if (res.converged) {
          slot.classList.add("ok");
          slot.querySelector(".slot-state").textContent = "✓ 收敛(" + res.used + "条)";
          slot.querySelector(".slot-pred").textContent = res.prediction + " " + (res.probability * 100).toFixed(1) + "%";
        } else if (res.prediction) {
          slot.classList.add("weak");
          slot.querySelector(".slot-state").textContent = "△ 未收敛";
          slot.querySelector(".slot-pred").textContent = res.prediction + " " + (res.probability * 100).toFixed(1) + "%";
        } else if (card.stopRequested) {
          slot.querySelector(".slot-state").textContent = "— 中断";
          slot.querySelector(".slot-pred").textContent = "";
        } else {
          slot.classList.add("fail");
          slot.querySelector(".slot-state").textContent = "✗ 失败";
          slot.querySelector(".slot-pred").textContent = res.error || "无有效回答";
        }
        finishIfDone();
      });
    };
    for (var i = 0; i < card.total; i += 1) { launch(i); }
  }

  function renderStabilityVerdict(card) {
    var badge = card.el.querySelector(".converge-badge");
    var summary = card.el.querySelector(".stability-summary");
    var done = card.rounds.filter(function (r) { return !!r; });
    var conv = done.filter(function (r) { return r.converged; });
    var preds = {};
    conv.forEach(function (r) { preds[r.prediction] = (preds[r.prediction] || 0) + 1; });
    var predNames = Object.keys(preds);
    badge.hidden = false;
    summary.hidden = false;
    card.el.querySelector(".stability-stop").disabled = true;
    if (card.stopRequested) {
      badge.className = "converge-badge pending";
      badge.textContent = "已停止";
      summary.innerHTML = "完成 " + done.length + "/" + card.total + " 轮后手动停止，收敛 " + conv.length + " 轮";
      return;
    }
    if (conv.length === card.total && predNames.length === 1) {
      var sole = predNames[0];
      if (window.UNIFIED_SUMMARY.models.some(function (m) { return modelMatches(card.model, m.id) === true; }) && modelMatches(card.model, sole) === false) {
        badge.className = "converge-badge exhausted";
        badge.textContent = "✗ 稳定但指纹不一致";
        summary.innerHTML = "<strong>" + card.total + "/" + card.total + " 轮收敛</strong>，但全部判定为 <strong>" + esc(sole) +
          "</strong>，与请求的「" + esc(card.model) + "」不符。<span class=\"stability-warn\">多轮指纹均与声明模型不一致；请结合其他证据判断。</span>";
      } else {
        badge.className = "converge-badge ok";
        badge.textContent = "✓ 稳定";
        summary.innerHTML = "<strong>" + card.total + "/" + card.total + " 轮收敛</strong>，判定一致：<strong>" + esc(sole) + "</strong>";
      }
    } else {
      badge.className = "converge-badge exhausted";
      badge.textContent = "✗ 不稳定";
      var parts = predNames.map(function (name) { return esc(name) + " × " + preds[name]; });
      summary.innerHTML = "收敛 <strong>" + conv.length + "/" + card.total + "</strong> 轮" +
        (predNames.length ? "，判定分布：" + parts.join("，") : "，无收敛判定") +
        ' <span class="stability-warn">多轮结果未保持一致</span>';
    }
  }

  /* ---------- 手动粘贴模式 ---------- */

  var manualChallenges = [];

  $("#manual-generate").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    api("/api/challenges", undefined, "GET").then(function (data) {
      manualChallenges = data.challenges || [];
      var list = $("#manual-challenge-list");
      list.innerHTML = "";
      manualChallenges.forEach(function (challenge, index) {
        var item = document.createElement("div");
        item.className = "challenge-item";
        item.innerHTML =
          '<div class="challenge-header"><span>挑战 ' + (index + 1) + "</span><span>目标约 " + challenge.expected_count + ' 个数字</span></div>' +
          '<div class="challenge-columns"><div><label>提示词</label><pre>' + esc(challenge.prompt) + "</pre></div>" +
          '<div><label>粘贴模型完整输出</label><textarea data-manual-output="' + index + '"></textarea></div></div>';
        list.appendChild(item);
      });
    }).catch(function (error) {
      showMessage(testMessage, "error", "生成挑战失败：" + error.message);
    }).finally(function () { button.disabled = false; });
  });

  $("#manual-analyze").addEventListener("click", function () {
    var outputs = [];
    $$("[data-manual-output]").forEach(function (area, index) {
      if (area.value.trim()) {
        outputs.push({ text: area.value, expected_count: manualChallenges[index] ? manualChallenges[index].expected_count : 0 });
      }
    });
    if (!outputs.length) { showMessage(testMessage, "error", "请至少粘贴一份模型输出"); return; }
    var button = this;
    button.disabled = true;
    api("/api/analyze", { outputs: outputs }).then(function (result) {
      hideMessage(testMessage);
      var panel = $("#manual-result");
      panel.hidden = false;
      var rows = result.results.map(function (item) {
        var pct = (item.probability * 100);
        return '<tr><td>' + esc(item.model) + '</td><td><div class="probability-cell"><span><i style="width:' + Math.max(0.3, pct).toFixed(1) + '%"></i></span>' + pct.toFixed(2) + "%</div></td><td>" + item.profile_similarity.toFixed(3) + "</td></tr>";
      }).join("");
      panel.innerHTML =
        '<div class="result-summary">' +
        "<div><span>判定模型</span><strong>" + esc(result.prediction_name || result.prediction) + "</strong></div>" +
        "<div><span>概率</span><strong>" + (result.probability * 100).toFixed(2) + "%</strong></div>" +
        "<div><span>家族</span><strong>" + esc(result.family_prediction_name) + " " + (result.family_probability * 100).toFixed(1) + "%</strong></div>" +
        "<div><span>有效回答</span><strong>" + result.used_outputs + "</strong></div></div>" +
        '<div class="table-wrap"><table><thead><tr><th>模型</th><th>概率</th><th>相似度</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="result-note"><span>结果仅供参考，非决定性证据</span><span>' + esc(result.method) + "</span></div>";
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }).catch(function (error) {
      showMessage(testMessage, "error", "计算失败：" + error.message);
    }).finally(function () { button.disabled = false; });
  });

  /* ---------- 指纹库：GitHub 更新 ---------- */

  if (window.ModelTracePortable) {
    loadProviders(window.ModelTracePortable.defaultProviderId);
    window.ModelTracePortable.initialize();
    return;
  }

  var gitMessage = $("#git-message");

  function renderGitState(state) {
    if (state.supported === false) {
      ["#git-check", "#git-update", "#git-auto-enabled", "#git-interval", "#git-save-settings"].forEach(function (id) { $(id).disabled = true; });
    }
    $("#git-head").textContent = state.head || "—";
    $("#git-remote").textContent = state.remote || "—";
    $("#git-behind").textContent = state.behind === undefined ? "—" : (state.behind + " 个提交");
    $("#git-last-check").textContent = fmtTime(state.last_check);
    $("#git-last-update").textContent = fmtTime(state.last_update);
    if (state.settings) {
      $("#git-auto-enabled").checked = !!state.settings.auto_update_enabled;
      $("#git-interval").value = state.settings.interval_hours || 24;
    }
    var conflictsEl = $("#git-conflicts");
    if (state.conflicts && state.conflicts.length) {
      conflictsEl.hidden = false;
      conflictsEl.innerHTML = "以下本地改动文件与上游更新冲突，请先手动处理：<br>" +
        state.conflicts.map(function (f) { return "<code>" + esc(f) + "</code>"; }).join("");
    } else {
      conflictsEl.hidden = true;
      conflictsEl.innerHTML = "";
    }
    if (state.message) {
      var type = state.conflicts && state.conflicts.length ? "working" : (state.up_to_date ? "success" : "working");
      showMessage(gitMessage, type, state.message);
    }
  }

  function loadGitStatus() {
    api("/api/bank/git/status", undefined, "GET").then(renderGitState).catch(function () { /* 首次无状态可忽略 */ });
  }

  $("#git-check").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    showMessage(gitMessage, "working", "正在检查 GitHub 更新…");
    api("/api/bank/git/check").then(function (state) {
      renderGitState(state);
    }).catch(function (error) {
      showMessage(gitMessage, "error", "检查失败：" + error.message);
    }).finally(function () { button.disabled = false; });
  });

  $("#git-update").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    showMessage(gitMessage, "working", "正在更新指纹库…");
    api("/api/bank/git/update").then(function (state) {
      renderGitState(state);
      if (state.unified) {
        $("#topbar-bank-count").textContent = state.unified.model_count + " 个候选模型";
        $("#active-bank-badge").textContent = state.unified.model_count + " 个候选模型";
      }
      showMessage(gitMessage, "success", (state.message || "更新完成") + "，即将刷新页面…");
      setTimeout(function () { location.reload(); }, 1500);
    }).catch(function (error) {
      showMessage(gitMessage, "error", error.message);
      loadGitStatus();
    }).finally(function () { button.disabled = false; });
  });

  $("#git-save-settings").addEventListener("click", function () {
    api("/api/bank/git/settings", {
      auto_update_enabled: $("#git-auto-enabled").checked,
      interval_hours: Number($("#git-interval").value) || 24
    }).then(function () {
      showMessage(gitMessage, "success", "设置已保存");
    }).catch(function (error) {
      showMessage(gitMessage, "error", "保存失败：" + error.message);
    });
  });

  /* ---------- 指纹库：浏览 / 新建 / 删除 ---------- */

  var bankSelect = $("#bank-select");
  var enrollMessage = $("#enrollment-message");

  function currentBankId() { return bankSelect.value; }

  function isCustomBank(bankId) { return !!(window.BANK_SUMMARIES[bankId] && window.BANK_SUMMARIES[bankId].custom); }

  function loadBankInventory() {
    var bankId = currentBankId();
    if (!bankId) { return; }
    api("/api/bank?bank_id=" + encodeURIComponent(bankId), undefined, "GET").then(function (summary) {
      window.BANK_SUMMARIES[bankId] = summary;
      var list = $("#bank-inventory");
      if (!summary.models || !summary.models.length) {
        list.innerHTML = '<span class="empty-inventory">此指纹库还没有模型，使用下方表单录入</span>';
      } else {
        list.innerHTML = summary.models.map(function (model) {
          return '<span class="fingerprint-item" title="回答 ' + model.responses + " 条 · 数字 " + model.valid_numbers + ' 个">' + esc(model.id) + "</span>";
        }).join("");
      }
      $("#bank-source-note").textContent = summary.custom
        ? "自定义指纹库：数据保存在本地，不受 GitHub 更新影响"
        : "内置指纹库：随 GitHub 仓库更新；向其录入指纹会产生本地改动";
      $("#delete-bank").hidden = !summary.custom;
    }).catch(function (error) {
      showMessage(enrollMessage, "error", "读取指纹库失败：" + error.message);
    });
  }

  bankSelect.addEventListener("change", loadBankInventory);

  $("#show-create-bank").addEventListener("click", function () {
    var form = $("#create-bank-form");
    form.hidden = !form.hidden;
  });

  $("#create-bank-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var label = $("#new-bank-name").value.trim();
    if (!label) { return; }
    api("/api/banks", { label: label }).then(function (data) {
      $("#new-bank-name").value = "";
      $("#create-bank-form").hidden = true;
      rebuildBankSelect(data.banks);
      bankSelect.value = data.bank.id;
      loadBankInventory();
      showMessage(enrollMessage, "success", "指纹库「" + label + "」已创建");
    }).catch(function (error) {
      showMessage(enrollMessage, "error", "创建失败：" + error.message);
    });
  });

  function rebuildBankSelect(banks) {
    window.BANK_SUMMARIES = banks;
    bankSelect.innerHTML = "";
    Object.keys(banks).forEach(function (id) {
      var option = document.createElement("option");
      option.value = id;
      option.textContent = banks[id].label;
      bankSelect.appendChild(option);
    });
  }

  $("#delete-bank").addEventListener("click", function () {
    var bankId = currentBankId();
    if (!bankId || !isCustomBank(bankId)) { return; }
    if (!window.confirm("确定删除自定义指纹库「" + bankId + "」？其中的指纹数据将一并删除。")) { return; }
    api("/api/banks/" + encodeURIComponent(bankId), undefined, "DELETE").then(function (data) {
      rebuildBankSelect(data.banks);
      bankSelect.value = window.DEFAULT_BANK_ID;
      loadBankInventory();
      showMessage(enrollMessage, "success", "已删除指纹库「" + bankId + "」");
    }).catch(function (error) {
      showMessage(enrollMessage, "error", "删除失败：" + error.message);
    });
  });

  /* ---------- 指纹库：录入 ---------- */

  $$("[data-enroll-mode]").forEach(function (tab) {
    tab.addEventListener("click", function (event) {
      event.preventDefault();
      $$("[data-enroll-mode]").forEach(function (t) { t.classList.toggle("active", t === tab); });
      $$(".enroll-panel").forEach(function (p) { p.classList.remove("active"); });
      $(tab.dataset.enrollMode === "api" ? "#auto-enrollment" : "#paste-enrollment").classList.add("active");
    });
  });

  $("#auto-enrollment").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = this.querySelector("button[type=submit]");
    button.disabled = true;
    showMessage(enrollMessage, "working", "正在自动采集指纹，请保持页面打开…");
    var temperature = $("#temperature").value;
    api("/api/enroll/auto", {
      bank_id: currentBankId(),
      base_url: $("#api-base").value.trim(),
      api_key: $("#api-key").value,
      api_model: $("#api-model").value.trim(),
      model_label: $("#auto-model").value.trim(),
      sample_count: Number($("#sample-count").value) || 36,
      temperature: temperature === "" ? null : Number(temperature)
    }).then(function (result) {
      showMessage(enrollMessage, "success", "采集完成：接受 " + result.accepted + " 条，拒绝 " + result.rejected + " 条");
      loadBankInventory();
    }).catch(function (error) {
      showMessage(enrollMessage, "error", "采集失败：" + error.message);
    }).finally(function () { button.disabled = false; });
  });

  $("#paste-enrollment").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = this.querySelector("button[type=submit]");
    button.disabled = true;
    api("/api/enroll/manual", {
      bank_id: currentBankId(),
      model_label: $("#paste-model").value.trim(),
      pasted: $("#paste-outputs").value
    }).then(function (result) {
      showMessage(enrollMessage, "success", "录入完成：接受 " + result.accepted + " 条，拒绝 " + result.rejected + " 条");
      $("#paste-outputs").value = "";
      loadBankInventory();
    }).catch(function (error) {
      showMessage(enrollMessage, "error", "录入失败：" + error.message);
    }).finally(function () { button.disabled = false; });
  });

  loadProviders();

})();
