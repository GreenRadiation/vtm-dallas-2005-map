/*
 * Карта Далласа и Форт-Уэрта 2005 для «Вампиры: Маскарад» (V20).
 * Регионы — дерево (data/tree.tsv → data/geo/tree/*.geojson, собирает tools/build.py, см. docs/TREE.md).
 * Сначала видны только верхние узлы. Двойной клик или «Раскрыть» раскрывает регион на его детей; раскрыта всегда
 * одна ветка. Карта сама двигается только по поиску, «Показать на карте» и ссылке. Переключатель «Все районы»
 * показывает сразу все листья дерева (для проверки нарезки). Озёра и парки — отдельный слой поверх, кликается всегда.
 * Тексты, метки и теги — data/map.json, данные переписи 2000 — data/census.json (tools/census.py).
 * Личные пометки игрока — только в его браузере (localStorage).
 * Подробности устройства: docs/MAP.md
 */
(function () {
"use strict";

var GEO = "data/geo/", TREE = GEO + "tree/";
var STORE_KEY = "vtm-dallas-2005-map.personal.v1";
var VIEW_KEY = "vtm-dallas-2005-map.view";
var BOUNDS = [[32.58, -97.55], [33.08, -96.50]];
var MLABEL = {haven: "Убежище", ally: "Союзники", hostile: "Враждебность", important: "Важное место"};
var NATKIND = {water: "Озеро", green: "Природная зона"};
// Сетки старой карты: чтобы показать клетки поверх
var GRIDS = {
  city: {cols: 9, rows: 9, n: 33.02, s: 32.62, w: -96.99, e: -96.55, label: "Даллас"},
  core: {cols: 8, rows: 8, n: 32.842222, s: 32.753333, w: -96.843333, e: -96.745556, label: "центр Далласа"},
  fw: {cols: 9, rows: 9, n: 33.00, s: 32.60, w: -97.55, e: -97.11, label: "Форт-Уэрт"}
};
var LET = "ABCDEFGHI";

var geo = {}, text = {nodes: {}, nature: {}}, census = {nodes: {}}, aliases = {};
var idx = {}, kidsOf = {}; // узел по id; дети по id родителя ("" — верхний уровень)
var loaded = {}, regLayer = {}; // загруженные файлы детей и их слои: по id родителя
var open = []; // раскрытая ветка: путь от верхнего уровня
var view = {leaves: false, lens: "", dart: false, ref: null}; // leaves — режим проверки: все листья дерева сразу, без раскрытия; ref — точка отсчёта
var sel = null; // {k: "n" | "nat", id}
var editing = false, status = "", moreOpen = {};
var map, featOf = {n: {}, nat: {}}, layerOf = {n: {}, nat: {}}, labelLayer, natLayer;
var selLayer = null, gridLayer, gridLabels, extra = {}, lensLayer = null, lensReady = null;
var panel = document.getElementById("panel");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]; }); }
// Markdown в описаниях, заметках и метках: *курсив* и _курсив_, **жирный**, __подчёркнутый__, ~~зачёркнутый~~, `код`,
// [ссылка](https://…), «> цитата», «---» — линия, списки «- » и «1. », заголовки «# ». Одиночный перевод строки — перенос.
// Текст сначала экранируется, так что HTML из него не проходит.
var MD_HR = /^ {0,3}([-*_])( *\1){2,} *$/, MD_H = /^ {0,3}(#{1,3}) +(.*)$/, MD_Q = /^ {0,3}>/, MD_UL = /^ {0,3}[-*+] +/, MD_OL = /^ {0,3}(\d{1,3})[.)] +/; // до трёх цифр: «2005. Год…» — не список
function mdInline(s) {
  var keep = [], put = function (h) { keep.push(h); return "\u0000" + (keep.length - 1) + "\u0000"; };
  s = esc(s).replace(/\\([\\`*_~[\]()#>.-])/g, function (_, c) { return put(c); })
    .replace(/`([^`\n]+)`/g, function (_, c) { return put("<code>" + c + "</code>"); })
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) { return put('<a href="' + u + '" target="_blank" rel="noopener">') + t + put("</a>"); })
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<u>$1</u>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "<i>$1</i>")
    .replace(/(^|[^\p{L}\p{N}])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return keep[i]; });
}
function md(t) {
  var lines = String(t || "").replace(/\r/g, "").split("\n"), out = [], i = 0, m;
  var block = function (l) { return MD_HR.test(l) || MD_H.test(l) || MD_Q.test(l) || MD_UL.test(l) || MD_OL.test(l); };
  var take = function (re) { var buf = []; while (i < lines.length && re.test(lines[i])) buf.push(lines[i++].replace(re, "")); return buf; };
  var items = function (buf) { return buf.map(function (x) { return "<li>" + mdInline(x) + "</li>"; }).join(""); };
  while (i < lines.length) {
    var l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (MD_HR.test(l)) { out.push("<hr>"); i++; }
    else if ((m = MD_H.exec(l))) { out.push('<h4 class="md-h' + m[1].length + '">' + mdInline(m[2]) + "</h4>"); i++; }
    else if (MD_Q.test(l)) out.push("<blockquote>" + md(take(/^ {0,3}> ?/).join("\n")) + "</blockquote>");
    else if (MD_UL.test(l)) out.push("<ul>" + items(take(MD_UL)) + "</ul>");
    else if ((m = MD_OL.exec(l))) out.push("<ol" + (+m[1] !== 1 ? ' start="' + +m[1] + '"' : "") + ">" + items(take(MD_OL)) + "</ol>");
    else {
      var p = [];
      while (i < lines.length && lines[i].trim() && !block(lines[i])) p.push(lines[i++].trim());
      out.push("<p>" + mdInline(p.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
  }
  return out.join("");
}
var MD_HINT = '<p class="hint mdhint">Можно Markdown: <b>**жирный**</b>, <i>*курсив*</i>, <u>__подчёркнутый__</u>, <s>~~зачёркнутый~~</s>, «&gt; цитата», «---» — линия, «- » — список.</p>';
// Тот же текст без разметки — для поиска и подсказок
function plain(t) {
  var keep = [], put = function (_, c) { keep.push(c); return "\u0000" + (keep.length - 1) + "\u0000"; };
  return String(t || "").replace(/\\([\\`*_~[\]()#>.-])/g, put).replace(/`([^`\n]+)`/g, put)
    .replace(/^ {0,3}([-*_])( *\1){2,} *$/gm, "").replace(/^ {0,3}(> ?)+|^ {0,3}(#{1,3}|[-*+]|\d{1,3}[.)]) +/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "$1").replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1").replace(/(^|[^\p{L}\p{N}])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/\u0000(\d+)\u0000/g, function (_, i) { return keep[i]; });
}
function skey(s) { return s.k + ":" + s.id; }
function info(s) { return (s.k === "nat" ? text.nature[s.id] : text.nodes[s.id]) || {}; }
function store(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }
function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function isOpen(id) { return view.leaves ? !!(idx[id] && idx[id].n) : open.indexOf(id) >= 0; }
function ancestors(id) { var out = [], p = idx[id] && idx[id].parent; while (p) { out.unshift(p); p = idx[p].parent; } return out; }
function nameOf(s) {
  if (s.k === "n") return idx[s.id].name;
  var f = featOf[s.k][s.id]; return f ? f.properties.name : "";
}

// ---------- метки: слоты ----------
// Слот — набор меток одного автора: точки на карте и заметки к регионам. Слоты лежат в браузере, каждый сохраняется
// в файл и загружается отдельно: мастер раздаёт свои метки слотом, игрок обновляет его файлом, не трогая свои.
// Слот: {id, name, on, tags: {тег: цвет}, pins: [{id, ll: [широта, долгота], icon, color, title, tags: [], text}],
//        regions: {"n:<узел>" | "nat:<озеро или парк>": {color, tags: [], text}}}
var MARKS_KEY = "vtm-dallas-2005-map.marks.v2", FILE_FORMAT = "vtm-dallas-2005-marks";
var PALETTE = ["#d6453a", "#e8892b", "#e3c22f", "#4c9a47", "#2a9187", "#3a74cc", "#7b5ccc", "#c4509b", "#8a6a2c", "#5f6876"];
var OLD = {haven: ["home", "#2f8a46"], ally: ["users", "#1f7368"], hostile: ["skull", "#b0242d"], important: ["star", "#a86a00"]};
var marks = {active: "", slots: []};
var placing = false, draft = null, isNewPin = false, noteSlot = "", confirmDel = false;

function uid() { return Math.random().toString(36).slice(2, 10); }
function allSlots() { return marks.slots; }
function slotOf(id) { return allSlots().filter(function (x) { return x.id === id; })[0] || null; }
function activeSlot() { return slotOf(marks.active) || marks.slots[0] || null; }
function newSlot(name) { var s = {id: uid(), name: name, on: true, tags: {}, pins: [], regions: {}}; marks.slots.push(s); return s; }
function pinOf(s) { var slot = s && slotOf(s.slot); return slot ? slot.pins.filter(function (p) { return p.id === s.id; })[0] || null : null; }
function validKey(k) { var g = k.split(":"), id = g.slice(1).join(":"); return (g[0] === "n" && !!idx[id]) || (g[0] === "nat" && !!natFeat(id)); }
function natFeat(id) { return geo.nature.features.filter(function (f) { return f.properties.id === id; })[0] || null; }
function keyName(k) { var g = k.split(":"), id = g.slice(1).join(":"); return g[0] === "n" ? idx[id].name : natFeat(id).properties.name; }
function keyCenter(k) { var g = k.split(":"), id = g.slice(1).join(":"), p = g[0] === "n" ? idx[id] : natFeat(id).properties; return [p.ly, p.lx]; }
function fixKey(k) { return validKey(k) ? k : aliases[k] && idx[aliases[k]] ? "n:" + aliases[k] : null; }
function tagsColored(slot, list) { // теги без цвета получают следующий цвет палитры
  list.forEach(function (t) { if (!slot.tags[t]) slot.tags[t] = PALETTE[Object.keys(slot.tags).length % PALETTE.length]; });
}
function counts(s) {
  var p = s.pins.length, r = Object.keys(s.regions).length;
  return p || r ? [p ? p + " " + plural(p, "метка", "метки", "меток") : "", r ? r + " " + plural(r, "регион", "региона", "регионов") : ""].filter(Boolean).join(", ") : "пусто";
}
function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; }

// Пометки первой версии ({items: {"n:…": {marker, label, notes}}}): с меткой — точка в центре региона, без — заметка к региону
function fromOld(items) {
  var out = {tags: {}, pins: [], regions: {}};
  Object.keys(items || {}).forEach(function (k0) {
    var k = fixKey(k0), o = items[k0] || {}; if (!k) return;
    var notes = String(o.notes || "").trim(), label = String(o.label || "").trim(), m = OLD[o.marker];
    if (m) {
      out.tags[MLABEL[o.marker]] = m[1];
      out.pins.push({id: uid(), ll: keyCenter(k), icon: m[0], color: m[1], title: label || keyName(k), tags: [MLABEL[o.marker]], text: notes});
    } else if (label || notes) {
      var r = out.regions[k] = out.regions[k] || {color: "", tags: [], text: ""};
      if (label && r.tags.indexOf(label) < 0) r.tags.push(label);
      if (notes) r.text = (r.text ? r.text + "\n\n" : "") + notes;
      tagsColored(out, r.tags);
    }
  });
  return out;
}
// Содержимое слота из файла или хранилища: всё проверяем, лишнее отбрасываем
function cleanSlot(p) {
  var hex = /^#[0-9a-f]{6}$/i, out = {tags: {}, pins: [], regions: {}}, seen = {};
  function str(v, n) { return String(v == null ? "" : v).slice(0, n); }
  function tags(a) { return (Array.isArray(a) ? a : []).map(function (t) { return str(t, 40).trim(); }).filter(function (t, i, all) { return t && all.indexOf(t) === i; }).slice(0, 12); }
  Object.keys(p.tags || {}).forEach(function (t) { var c = p.tags[t]; t = str(t, 40).trim(); if (t) out.tags[t] = hex.test(c) ? c : PALETTE[9]; });
  (Array.isArray(p.pins) ? p.pins : []).forEach(function (q) {
    var ll = q && q.ll; if (!Array.isArray(ll) || !isFinite(ll[0]) || !isFinite(ll[1])) return;
    var id = str(q.id, 20) || uid(); if (seen[id]) id = uid(); seen[id] = 1;
    out.pins.push({id: id, ll: [+ll[0], +ll[1]], icon: PIN[q.icon] ? q.icon : "dot", color: hex.test(q.color) ? q.color : PALETTE[0],
      title: str(q.title, 120), tags: tags(q.tags), text: str(q.text, 20000)});
  });
  Object.keys(p.regions || {}).forEach(function (k0) {
    var r = p.regions[k0] || {}, k = fixKey(k0); if (!k) return;
    out.regions[k] = {color: hex.test(r.color) ? r.color : "", tags: tags(r.tags), text: str(r.text, 20000)};
  });
  out.pins.forEach(function (q) { tagsColored(out, q.tags); });
  Object.keys(out.regions).forEach(function (k) { tagsColored(out, out.regions[k].tags); });
  return out;
}
// Файл: этой системы, первой версии этой карты ({items}) или старой карты в клетку ({cells})
function slotFromFile(p) {
  if (p && p.format === FILE_FORMAT) return {name: String(p.name || "").slice(0, 60), body: cleanSlot(p)};
  if (p && p.items && typeof p.items === "object") return {name: "", body: fromOld(p.items)};
  if (p && p.cells && typeof p.cells === "object") {
    var items = {};
    Object.keys(p.cells).forEach(function (k) {
      var to = aliases[k], c = p.cells[k] || {}; if (!to) return;
      items["n:" + to] = {marker: c.marker, label: c.label, notes: c.notes ? "[старая клетка " + k + "] " + c.notes : ""};
    });
    return {name: "", body: fromOld(items)};
  }
  throw new Error("bad");
}

function loadMine() {
  try { var v = JSON.parse(load(VIEW_KEY) || "{}"); view.leaves = !!v.leaves; view.lens = LENS[v.lens] ? v.lens : ""; view.dart = !!v.dart;
    if (v.ref && /^(n|nat|pin)$/.test(v.ref.k)) view.ref = {k: v.ref.k, id: String(v.ref.id), slot: v.ref.slot ? String(v.ref.slot) : undefined}; } catch (_) {}
  var raw = null;
  try { raw = JSON.parse(load(MARKS_KEY) || "null"); } catch (_) {}
  if (raw && Array.isArray(raw.slots)) {
    raw.slots.forEach(function (s) {
      var c = cleanSlot(s || {}); c.id = String(s.id || uid()).slice(0, 20); c.name = String(s.name || "Слот").slice(0, 60); c.on = s.on !== false;
      marks.slots.push(c);
    });
    marks.active = raw.active || "";
  } else { // первый запуск: переносим пометки первой версии в слот «Мои метки»
    var old = null;
    try { old = JSON.parse(load(STORE_KEY) || "null"); } catch (_) {}
    var s = newSlot("Мои метки"), c = old && old.items ? fromOld(old.items) : null;
    if (c) { s.tags = c.tags; s.pins = c.pins; s.regions = c.regions; }
    marks.active = s.id; saveMarks();
  }
  if (!slotOf(marks.active)) marks.active = marks.slots.length ? marks.slots[0].id : "";
}
function saveMarks() {
  try { localStorage.setItem(MARKS_KEY, JSON.stringify({active: marks.active, slots: marks.slots})); return true; }
  catch (_) { return false; }
}
// Заметки видимых слотов к региону и цвет, которым его красить (активный слот главнее)
function regionNotes(k) {
  return allSlots().filter(function (s) { return s.on && s.regions[k]; }).map(function (s) { return {slot: s, r: s.regions[k]}; });
}
function regionColor(k) {
  var a = activeSlot(), c = "";
  allSlots().forEach(function (s) { if (s.on && s.regions[k] && s.regions[k].color) c = s.regions[k].color; });
  return a && a.on && a.regions[k] && a.regions[k].color || c;
}
function tagChips(slot, list) {
  return (list || []).length ? '<div class="tchips">' + list.map(function (t) { return '<span class="tchip" style="--c:' + (slot.tags[t] || PALETTE[9]) + '">' + esc(t) + '</span>'; }).join("") + '</div>' : "";
}

// ---------- метки: точки на карте ----------
// Значки — линии в духе Tabler Icons (MIT)
var PIN = {
  dot: ["M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"],
  home: ["M5 12l-2 0l9 -9l9 9l-2 0", "M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7", "M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"],
  glass: ["M8 21h8", "M12 15v6", "M12 5m-7 0a7 2 0 1 0 14 0a7 2 0 1 0 -14 0", "M5 5v.388c0 .432 .126 .853 .362 1.206l5 7.509c.633 .951 1.88 1.183 2.785 .517c.191 -.141 .358 -.316 .491 -.517l5 -7.509c.236 -.353 .362 -.774 .362 -1.206v-.388"],
  building: ["M3 21l18 0", "M9 8l1 0", "M9 12l1 0", "M9 16l1 0", "M14 8l1 0", "M14 12l1 0", "M14 16l1 0", "M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16"],
  eye: ["M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0", "M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"],
  star: ["M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"],
  users: ["M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2", "M16 3.13a4 4 0 0 1 0 7.75", "M21 21v-2a4 4 0 0 0 -3 -3.85"],
  skull: ["M12 4c4.418 0 8 3.358 8 7.5c0 1.901 -.755 3.637 -2 4.96v2.54a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-2.54c-1.245 -1.322 -2 -3.058 -2 -4.96c0 -4.142 3.582 -7.5 8 -7.5z", "M10 17v3", "M14 17v3", "M9 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M15 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"],
  drop: ["M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0c2.602 -2.105 3.262 -5.708 1.566 -8.546l-4.89 -7.26c-.42 -.625 -1.287 -.803 -1.936 -.397a1.376 1.376 0 0 0 -.41 .397l-4.893 7.26c-1.695 2.838 -1.035 6.441 1.567 8.546z"],
  heart: ["M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"],
  shield: ["M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"],
  crown: ["M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4z"],
  flag: ["M5 5a5 5 0 0 1 7 0a5 5 0 0 0 7 0v9a5 5 0 0 1 -7 0a5 5 0 0 0 -7 0v-9z", "M5 21v-7"],
  key: ["M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z", "M15 9h.01"],
  alert: ["M12 9v4", "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z", "M12 16h.01"],
  moon: ["M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"],
  cross: ["M12 3v18", "M7 8h10"],
  coin: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1", "M12 7v10"],
  blade: ["M20 4v5l-9 7l-4 4l-3 -3l4 -4l7 -9z", "M6.5 11.5l6 6"],
  question: ["M8 8a3.5 3 0 0 1 3.5 -3h1a3.5 3 0 0 1 3.5 3a3 3 0 0 1 -2 3a3 4 0 0 0 -2 4", "M12 19l0 .01"]
};
var PIN_NAME = {dot: "точка", home: "дом", glass: "бокал", building: "здание", eye: "глаз", star: "звезда", users: "люди", skull: "череп",
  drop: "капля", heart: "сердце", shield: "щит", crown: "корона", flag: "флаг", key: "ключ", alert: "опасность", moon: "луна",
  cross: "крест", coin: "деньги", blade: "клинок", question: "вопрос"};
var pinLayer = null, lastPinClick = {};
function pinSvg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (PIN[name] || PIN.dot).map(function (d) { return '<path d="' + d + '"/>'; }).join("") + '</svg>'; }
function isLight(hex) { var n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255) > 160; }
function pinHtml(p) { return '<span class="pinb' + (isLight(p.color) ? " lt" : "") + '" style="background:' + p.color + '">' + pinSvg(p.icon) + '</span>'; }
function drawPins() {
  if (!pinLayer) pinLayer = L.layerGroup().addTo(map);
  pinLayer.clearLayers();
  var list = [];
  allSlots().forEach(function (slot) { if (slot.on) slot.pins.forEach(function (p) { list.push([slot, p]); }); });
  if (draft && sel && sel.k === "pin" && isNewPin) list.push([slotOf(sel.slot), draft]);
  list.forEach(function (q) {
    var slot = q[0], p = q[1], on = sel && sel.k === "pin" && sel.slot === slot.id && sel.id === p.id, drag = on && editing;
    if (on && draft) p = draft;
    var m = L.marker(p.ll, {pane: "pins", keyboard: false, draggable: drag, zIndexOffset: on ? 1000 : 0, riseOnHover: true,
      icon: L.divIcon({className: "pin" + (on ? " on" : "") + (drag ? " drag" : ""), html: pinHtml(p), iconSize: [26, 26], iconAnchor: [13, 13]})});
    m.bindTooltip("<b>" + esc(p.title || "Метка") + "</b><small>" + esc((p.tags.length ? p.tags.join(", ") + " · " : "") + slot.name) + "</small>" +
      tripTip({k: "pin", slot: slot.id, id: p.id}, p.ll),
      {direction: "top", className: "tip", offset: [0, -14]});
    m.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      if (placeAt(e.latlng)) return;
      // двойной клик ловим по двум быстрым кликам: первый клик перерисовывает значок, и браузерный dblclick уходит в пустоту
      var key = slot.id + "/" + q[1].id, now = Date.now();
      if (lastPinClick.key === key && now - lastPinClick.t < 450) { lastPinClick = {}; openAt(q[1].ll); return; }
      lastPinClick = {key: key, t: now};
      selectPin(slot.id, q[1].id, false);
    });
    m.on("dblclick", function (e) { L.DomEvent.stopPropagation(e); });
    m.on("dragend", function () { var ll = m.getLatLng(); if (draft) draft.ll = [+ll.lat.toFixed(6), +ll.lng.toFixed(6)]; });
    pinLayer.addLayer(m);
  });
  renderRef(); // имя метки-отсчёта могло поменяться
}
function selectPin(slotId, id, fly) {
  var p = pinOf({slot: slotId, id: id}); if (!p) return;
  placeStop(); sel = {k: "pin", slot: slotId, id: id}; editing = false; draft = null; isNewPin = false; status = ""; confirmDel = false;
  drawSel(); drawPins(); renderPanel(); syncHash(); placeLabels();
  if (fly) map.flyTo(p.ll, Math.max(map.getZoom(), 13), {duration: 0.6});
}
// Раскрыть ветку дерева до района под точкой (для меток); камеру не трогаем
function openAt(ll) {
  leafPath(ll).then(function (path) {
    if (!path.length || view.leaves) return;
    var last = path[path.length - 1];
    open = idx[last].n ? path : path.slice(0, -1); syncLayers(); placeLabels();
  });
}
// Путь узлов от верхнего уровня до самого мелкого района под точкой; файлы детей подгружаются по дороге
function leafPath(ll) {
  var path = [];
  function step(parent) {
    return ensureKids(parent).then(function (fc) {
      var f = fc.features.filter(function (f) { return inFeat(f, ll[1], ll[0]); })[0];
      if (!f) return path;
      path.push(f.properties.id);
      return idx[f.properties.id].n ? step(f.properties.id) : path;
    });
  }
  return step("");
}
// Где метка: крошки до района под ней, дописываются в карточку, когда путь найден
function fillWhere(p) {
  leafPath(p.ll).then(function (path) {
    var el = document.getElementById("pin-where");
    if (el && path.length) el.innerHTML = path.map(function (a) { return '<a href="#n/' + esc(a) + '" data-go="n:' + esc(a) + '">' + esc(idx[a].name) + '</a>'; }).join("<span>›</span>");
  });
}
// Поставить метку: кнопка в карточке включает режим, следующий клик по карте ставит точку; правый клик ставит сразу
function placeStart() {
  placing = true; map.getContainer().classList.add("placing");
  var h = document.getElementById("place-hint"); if (h) h.hidden = false;
}
function placeStop() {
  placing = false; map.getContainer().classList.remove("placing");
  var h = document.getElementById("place-hint"); if (h) h.hidden = true;
}
function placeAt(ll) {
  if (!placing) return false;
  placeStop();
  var slot = activeSlot();
  if (!slot) { slot = newSlot("Мои метки"); marks.active = slot.id; saveMarks(); renderSlots(); }
  sel = {k: "pin", slot: slot.id, id: uid()}; editing = true; isNewPin = true; status = ""; confirmDel = false;
  draft = {id: sel.id, ll: [+ll.lat.toFixed(6), +ll.lng.toFixed(6)], icon: "dot", color: PALETTE[0], title: "", tags: [], text: ""};
  drawSel(); drawPins(); renderPanel(); syncHash();
  var t = document.getElementById("f-title"); if (t) t.focus();
  return true;
}

// ---------- мелочи ----------
function gridCell(b, lat, lon) {
  var G = GRIDS[b], c = Math.floor((lon - G.w) / ((G.e - G.w) / G.cols)), r = Math.floor((G.n - lat) / ((G.n - G.s) / G.rows));
  return (c >= 0 && c < G.cols && r >= 0 && r < G.rows) ? LET[c] + (r + 1) : null;
}

// ---------- точка отсчёта ----------
// Игрок делает точкой отсчёта регион или метку; от неё в карточках и подсказках пишется расстояние и время в пути.
// Дорог на карте нет, поэтому путь по дорогам — прямая с поправкой на извилистость: по городу примерно × 1,4,
// на дальних поездках по фривеям ближе к × 1,2. Время — ночью без пробок: по улицам около 30 км/ч, по фривеям до 90 км/ч.
function refOf() {
  var r = view.ref; if (!r) return null;
  if (r.k === "pin") { var p = pinOf({slot: r.slot, id: r.id}); return p ? {ll: p.ll, name: p.title || "Метка"} : null; }
  if (r.k === "n") return idx[r.id] ? {ll: [idx[r.id].ly, idx[r.id].lx], name: idx[r.id].name} : null;
  var f = natFeat(r.id); return f ? {ll: [f.properties.ly, f.properties.lx], name: f.properties.name} : null;
}
function isRef(s) { var r = view.ref; return !!r && r.k === s.k && r.id === s.id && (s.k !== "pin" || r.slot === s.slot); }
function setRef(s) {
  view.ref = s && !isRef(s) ? {k: s.k, id: s.id, slot: s.slot} : null;
  store(VIEW_KEY, JSON.stringify(view));
  renderRef(); drawPins(); renderPanel();
}
function km1(k) { return k < 10 ? k.toFixed(1).replace(".", ",") : String(Math.round(k)); }
function trip(ll) {
  var r = refOf(); if (!r) return null;
  var dx = (ll[1] - r.ll[1]) * 93.6, dy = (ll[0] - r.ll[0]) * 111, line = Math.sqrt(dx * dx + dy * dy), road = line * (1.2 + 0.2 * Math.max(0, 1 - line / 20));
  var car = 2 + road / (30 + 60 * Math.min(1, road / 40)) * 60, walk = road / 5 * 60;
  return {name: r.name, line: line, road: road, car: car, walk: walk};
}
function mins(m) {
  if (m < 2) return "пара минут";
  if (m < 15) return Math.round(m) + " мин";
  if (m < 55) return Math.round(m / 5) * 5 + " мин";
  var h = Math.floor((m + 5) / 60), r = Math.round((m - h * 60) / 10) * 10;
  return h + " ч" + (r > 0 ? " " + r + " мин" : "");
}
// Строка в карточку: где отсчёт и сколько до него
function tripLine(s, ll) {
  var t = trip(ll); if (!t) return "";
  if (isRef(s)) return '<p class="trip">Точка отсчёта: от неё считаются расстояния в карточках и подсказках.</p>';
  if (t.line < 0.4) return '<p class="trip">Рядом с точкой отсчёта «' + esc(t.name) + '».</p>';
  return '<p class="trip">До «' + esc(t.name) + '» ' + km1(t.line) + ' км по прямой, по дорогам около ' + km1(t.road) + ' км: ' +
    mins(t.car) + ' на машине' + (t.road < 5 ? ", " + mins(t.walk) + " пешком" : "") + '.</p>';
}
// Короткая строка в подсказку на карте
function tripTip(s, ll) {
  var t = trip(ll); if (!t || isRef(s)) return "";
  return "<small>" + (t.line < 0.4 ? "рядом с точкой отсчёта" : km1(t.road) + " км, " + mins(t.car) + " на машине") + "</small>";
}
// Плашка в шапке: от чего сейчас считаем; имя открывает точку, крестик убирает отсчёт
function renderRef() {
  var el = document.getElementById("ref"), r = refOf();
  if (!el) return;
  el.hidden = !r;
  if (r) el.innerHTML = '<span>Отсчёт от</span><button type="button" class="ref-go" title="Открыть точку отсчёта">' + esc(r.name) + '</button>' +
    '<button type="button" class="ib" data-ref-x title="Убрать точку отсчёта">×</button>';
}
function setupRef() {
  var el = document.getElementById("ref");
  el.addEventListener("click", function (e) {
    var r = view.ref; if (!r) return;
    if (e.target.closest("[data-ref-x]")) setRef(null);
    else if (e.target.closest(".ref-go")) { if (r.k === "pin") selectPin(r.slot, r.id, true); else select({k: r.k, id: r.id}, true); }
  });
  renderRef();
}
// Как назвать узел в карточке
function kindLabel(id) {
  var x = idx[id], top = !x.parent;
  if (x.kind === "aero") return "Аэропорт";
  if (x.kind === "osm" || x.kind === "place") return "Знаковое место";
  if (x.kind === "city") return top ? "Город" : "Отдельный город";
  if (x.kind === "group") return top ? "Пригороды" : "Отдельные города";
  return x.n ? "Часть города" : "Район";
}

// ---------- теги ----------
// Табличка с иконками; при наведении или нажатии под ней — что именно это значит в этом регионе. Ручные теги —
// map.json (поле tags: число или [от, до], пояснения к клеткам — tags.notes), перепись 2000 — census.json.
// Шкалы описаны в docs/TEXTS.md. Иконки — Tabler Icons (MIT), https://tabler.io/icons
var ICON = {"coin":["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0","M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1","M12 7v10"],"eye":["M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0","M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"],"glass":["M8 21h8","M12 15v6","M12 5m-7 0a7 2 0 1 0 14 0a7 2 0 1 0 -14 0","M5 5v.388c0 .432 .126 .853 .362 1.206l5 7.509c.633 .951 1.88 1.183 2.785 .517c.191 -.141 .358 -.316 .491 -.517l5 -7.509c.236 -.353 .362 -.774 .362 -1.206v-.388"],"shield":["M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"],"houses":["M5 12l-2 0l9 -9l9 9l-2 0","M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7","M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"],"estates":["M19.258 10.258l-7.258 -7.258l-9 9h2v7a2 2 0 0 0 2 2h4","M9 21v-6a2 2 0 0 1 2 -2h1.5","M17.8 20.817l-2.172 1.138a.392 .392 0 0 1 -.568 -.41l.415 -2.411l-1.757 -1.707a.389 .389 0 0 1 .217 -.665l2.428 -.352l1.086 -2.193a.392 .392 0 0 1 .702 0l1.086 2.193l2.428 .352a.39 .39 0 0 1 .217 .665l-1.757 1.707l.414 2.41a.39 .39 0 0 1 -.567 .411l-2.172 -1.138z"],"apts":["M8 9l5 5v7h-5v-4m0 4h-5v-7l5 -5m1 1v-6a1 1 0 0 1 1 -1h10a1 1 0 0 1 1 1v17h-8","M13 7l0 .01","M17 7l0 .01","M17 11l0 .01","M17 15l0 .01"],"towers":["M3 21l18 0","M5 21v-14l8 -4v18","M19 21v-10l-6 -4","M9 9l0 .01","M9 12l0 .01","M9 15l0 .01","M9 18l0 .01"],"industry":["M3 21h18","M5 21v-12l5 4v-4l5 4h4","M19 21v-8l-1.436 -9.574a.5 .5 0 0 0 -.495 -.426h-1.145a.5 .5 0 0 0 -.494 .418l-1.43 8.582","M9 17h1","M14 17h1"],"strip":["M3 21l18 0","M3 7v1a3 3 0 0 0 6 0v-1m0 1a3 3 0 0 0 6 0v-1m0 1a3 3 0 0 0 6 0v-1h-18l2 -4h14l2 4","M5 21l0 -10.15","M19 21l0 -10.15","M9 21v-4a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v4"],"fields":["M7 15m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0","M7 15l0 .01","M19 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0","M10.5 17l6.5 0","M20 15.2v-4.2a1 1 0 0 0 -1 -1h-6l-2 -5h-6v6.5","M18 5h-1a1 1 0 0 0 -1 1v4"],"campus":["M22 9l-10 -4l-10 4l10 4l10 -4v6","M6 10.6v5.4a6 3 0 0 0 12 0v-5.4"],"other":["M3 21l18 0","M9 8l1 0","M9 12l1 0","M9 16l1 0","M14 8l1 0","M14 12l1 0","M14 16l1 0","M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16"],"street":["M20 4v5l-9 7l-4 4l-3 -3l4 -4l7 -9z","M6.5 11.5l6 6"]};
var WEALTH = ["бедность", "ниже среднего", "средний достаток", "зажиточно", "богатство"];
var RACE = ["белые", "латиноамериканцы", "чёрные", "азиаты", "другие"];
var BUILD = {houses: "частные дома с участками", estates: "особняки", apts: "жилые комплексы", towers: "высотки",
  industry: "склады и промзона", strip: "торговля у фривея", fields: "поля и ранчо", campus: "кампус"};
// [название, что значит, если у региона нет своего пояснения]
var STREET = [null,
  ["тихо", "Преступлений почти нет."],
  ["спокойно", "На улице спокойно, изредка кражи из машин и домов."],
  ["неспокойно", "Бывают угоны и ограбления; ночью пешком лучше не ходить."],
  ["опасно", "Банды и торговля наркотиками, стрельба не редкость."],
  ["очень опасно", "Перестрелки, наркопритоны, заброшенные дома."]];
var EYES = [null,
  ["никому нет дела", "Свидетелей нет, полиция едет долго."],
  ["мало глаз", "Ночью на улицах пусто."],
  ["людно", "Вокруг люди: видят, но не запоминают."],
  ["присматривают", "Соседи замечают чужую машину и звонят в полицию."],
  ["под надзором", "Патрули и камеры, полиция за пару минут."]];
var NIGHT = [
  ["ничего", "После десяти вечера всё закрыто."],
  ["только круглосуточное", "Ночью открыты заправки, закусочные и магазины."],
  ["бары у дороги", "Пара баров и мест, открытых допоздна."],
  ["есть куда пойти", "Бары, клубы и рестораны допоздна."],
  ["центр ночной жизни", "Сюда едут развлекаться со всего города."]];
// у полиции Далласа пояснение общее на весь город, у остальных — своё в tags.notes.police
var POLICE = {
  dpd: ["Даллас", "Полиция Далласа, около трёх тысяч офицеров на весь город."],
  fwpd: ["Форт-Уэрт", "Полиция Форт-Уэрта, около полутора тысяч офицеров — вдвое меньше далласской."], city: ["своя", ""], sheriff: ["шериф", ""], campus: ["кампус", ""]};

function icon(name, cls) {
  return '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' +
    ICON[name].map(function (d) { return '<path d="' + d + '"/>'; }).join("") + '</svg>';
}
// v — число или [от, до]: до «от» иконки полные, между «от» и «до» — бледнее, дальше — пустые
function pips(name, v, max) {
  var lo = Array.isArray(v) ? v[0] : v, hi = Array.isArray(v) ? v[1] : v, out = "";
  for (var i = 1; i <= max; i++) out += icon(name, i <= lo ? "" : i <= hi ? "mid" : "off");
  return out;
}
// Заголовок подсказки и текст: своё пояснение региона, а если его нет — что значит значение шкалы
function scaled(v, names, own) {
  if (Array.isArray(v)) return ["от «" + names[v[0]][0] + "» до «" + names[v[1]][0] + "»", own || "Смотря где."];
  return [names[v][0], own || names[v][1]];
}
function wealthLevel(inc) {
  var r = inc / census.inc_ref;
  return r < 0.6 ? 1 : r < 0.9 ? 2 : r < 1.3 ? 3 : r < 2 ? 4 : 5;
}
function num(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function money(n) { return "$" + num(n); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
// Перепись показываем, только где живут хотя бы несколько сотен семей: в нежилых местах цифры ничего не значат
function censusOf(id) {
  var x = idx[id], c = x && census.nodes[id];
  return c && c.hh >= 300 && !/^(place|osm|aero)$/.test(x.kind) ? c : null;
}
function join(a) { return a.filter(Boolean).join(" "); }
var tagTexts = [], tagCells = [];
function tagsBlock(s) {
  var t = info(s).tags || {}, n = t.notes || {}, cells = [], c = s.k === "n" ? censusOf(s.id) : null, h;
  // клетка: [название, значение в табличке, заголовок подсказки, текст подсказки, широкая ли]
  if (c && c.inc) {
    var w = wealthLevel(c.inc), kids = (kidsOf[s.id] || []).filter(function (k) { return censusOf(k) && census.nodes[k].inc; })
      .sort(function (a, b) { return census.nodes[a].inc - census.nodes[b].inc; });
    var lo = kids[0], hi = kids[kids.length - 1];
    cells.push(["Достаток", pips("coin", w, 5), WEALTH[w - 1], join([money(c.inc) + " в год на семью.",
      kids.length > 1 ? "Беднее всего " + idx[lo].name + " (" + money(census.nodes[lo].inc) + "), богаче всего " + idx[hi].name + " (" + money(census.nodes[hi].inc) + ")." : "",
      n.wealth])]);
  }
  if (t.street != null) { h = scaled(t.street, STREET, n.street); cells.push(["Улица", pips("street", t.street, 5), h[0], h[1]]); }
  if (t.eyes != null) { h = scaled(t.eyes, EYES, n.eyes); cells.push(["Глаза", pips("eye", t.eyes, 5), h[0], h[1]]); }
  if (c) {
    var r = c.race.map(function (p, i) { return [p, i]; }).filter(function (q) { return q[0] > 0; }).sort(function (a, b) { return b[0] - a[0]; });
    var pop = c.pop >= 1e6 ? (c.pop / 1e6).toFixed(2).replace(".", ",") + " млн" : c.pop >= 10000 ? num(c.pop / 1000) + " тыс." : num(c.pop);
    cells.push(["Жители", '<span class="rbar">' + r.map(function (q) { return '<i class="r' + q[1] + '" style="width:' + q[0] + '%"></i>'; }).join("") +
      '</span><small>' + pop + '</small>', pop,
      join([cap(r.filter(function (q) { return q[0] >= 5; }).map(function (q) { return RACE[q[1]] + " " + q[0] + "%"; }).join(", ")) + ".", n.people]), "wide"]);
  }
  if (t.night != null) { h = scaled(t.night, NIGHT, n.night); cells.push(["Ночь", pips("glass", t.night, 4), h[0], h[1]]); }
  if (t.build || c) {
    var b = t.build || [], homes = "";
    if (c) {
      var hm = c.homes, parts = [];
      if (hm[0] >= 10) parts.push("частные дома " + hm[0] + "%");
      if (hm[1] >= 10) parts.push("дуплексы и малоэтажки " + hm[1] + "%");
      if (hm[2] >= 10) parts.push("комплексы от 10 квартир " + hm[2] + "%");
      if (hm[3] >= 10) parts.push("трейлеры " + hm[3] + "%");
      homes = cap(parts.join(", ")) + (c.built ? "; дома в среднем " + c.built + " года" : "") + "; жильё снимают " + (100 - c.own) + "%.";
    }
    cells.push(["Застройка", b.map(function (x) { return icon(BUILD[x] ? x : "other"); }).join("") || icon("other", "off"),
      b.map(function (x) { return BUILD[x] || x; }).join(", ") || "жильё", join([homes, n.build]), "wide"]);
  }
  if (t.police) {
    var p = POLICE[t.police] || [t.police, ""];
    cells.push(["Полиция", '<small>' + esc(p[0]) + '</small>', POLICE[t.police] ? "" : t.police, join([p[1], n.police])]);
  }
  tagCells = cells;
  tagTexts = cells.map(function (q) { return "<b>" + esc(q[0]) + (q[2] ? " — " + esc(q[2]) : "") + ".</b> " + esc(q[3]); });
  if (!cells.length) return "";
  return '<div class="tags">' + cells.map(function (q, i) {
    return '<div class="tag' + (q[4] ? " " + q[4] : "") + '" tabindex="0" data-i="' + i + '"><span>' + q[0] + '</span><div>' + q[1] + '</div></div>';
  }).join("") + '</div><p class="tagtip" id="tagtip">' + (window.matchMedia("(hover: none)").matches ? "Нажми" : "Наведи") + ' на клетку, чтобы узнать подробнее.</p>';
}
function bindTags() {
  var tip = document.getElementById("tagtip"), cur = null;
  if (!tip) return;
  panel.querySelectorAll(".tag").forEach(function (el) {
    function on() {
      if (cur) cur.classList.remove("on");
      cur = el; el.classList.add("on");
      tip.innerHTML = tagTexts[+el.getAttribute("data-i")]; tip.classList.add("on");
    }
    el.addEventListener("mouseenter", on); el.addEventListener("focus", on); el.addEventListener("click", on);
  });
}

// ---------- линзы ----------
// Линза перекрашивает регионы по одному параметру тегов. Шкалы — один цвет от светлого к насыщенному,
// категории — свой цвет у каждого значения; смешанный состав — диагональные полосы в пропорции долей.
var LENS_COLORS = {
  wealth: ["#f3e7c4", "#e6cf86", "#d4b04a", "#b88a1e", "#8a6410"],
  street: ["#f6e3df", "#eeb7aa", "#e2846f", "#c9503a", "#9b2a1c"],
  eyes: ["#e3ecf7", "#b5cdea", "#7ea8d8", "#4a7fc0", "#23559a"],
  night: ["#ece6f5", "#cdbbe6", "#a98ad3", "#8159bb", "#5a3496"]
};
var BUILD_COLOR = {houses: "#8fbf7f", estates: "#3f8a55", apts: "#e3a34f", towers: "#5a6f9c", industry: "#9a8f84",
  strip: "#d07a6a", fields: "#d9c98a", campus: "#7fb3c9", other: "#c2b8d6"};
var POLICE_COLOR = {dpd: "#4a7fc0", fwpd: "#c9503a", city: "#e3a34f", sheriff: "#8a6410", campus: "#7fb3c9", other: "#b4b2a9"};
var POLICE_NAME = {dpd: "полиция Далласа", fwpd: "полиция Форт-Уэрта", city: "своя полиция города", sheriff: "шериф округа",
  campus: "полиция кампуса", other: "другое"};
var POLICE_DESC = {dpd: "Одна полиция на весь Даллас, по вызовам из бедных районов едет не сразу.", fwpd: "Своя полиция Форт-Уэрта.",
  city: "Пригород — отдельный город со своей полицией; она маленькая и знает местных.", sheriff: "Земля вне городов: патрулирует шериф округа, патрули редкие.",
  campus: "Своя полиция университета: настоящие полицейские штата.", other: "Своя охрана или особый случай — подробнее в карточке."};
var LENS = {
  wealth: {name: "Достаток", n: 5, from: 1, colors: LENS_COLORS.wealth, label: function (v) { return WEALTH[v - 1]; },
    desc: function (v) {
      var r = census.inc_ref, b = [0, 0.6, 0.9, 1.3, 2].map(function (k) { return Math.round(r * k / 100) * 100; });
      return "Медианный доход семьи " + (v === 1 ? "меньше " + money(b[1]) : v === 5 ? "больше " + money(b[4]) : "от " + money(b[v - 1]) + " до " + money(b[v])) + " в год.";
    },
    get: function (s) { var c = s.k === "n" && censusOf(s.id); return c && c.inc ? wealthLevel(c.inc) : null; }},
  people: {name: "Жители", kind: "race"},
  street: {name: "Улица", n: 5, from: 1, colors: LENS_COLORS.street, label: function (v) { return STREET[v][0]; }, desc: function (v) { return STREET[v][1]; }, tag: "street"},
  eyes: {name: "Глаза", n: 5, from: 1, colors: LENS_COLORS.eyes, label: function (v) { return EYES[v][0]; }, desc: function (v) { return EYES[v][1]; }, tag: "eyes"},
  night: {name: "Ночная жизнь", n: 5, from: 0, colors: LENS_COLORS.night, label: function (v) { return NIGHT[v][0]; }, desc: function (v) { return NIGHT[v][1]; }, tag: "night"},
  build: {name: "Застройка", kind: "build"},
  police: {name: "Полиция", kind: "police"}
};
function tagVal(s, k) {
  var v = (info(s).tags || {})[k];
  if (v == null) return null;
  return Array.isArray(v) ? Math.round((v[0] + v[1]) / 2) : v;
}
function raceHex(i) { return getComputedStyle(document.documentElement).getPropertyValue(["--race-w", "--race-h", "--race-b", "--race-a", "--race-o"][i]).trim(); }

// Полосатые заливки: SVG-узоры в слое регионов, создаются по требованию
var patterns = {};
function stripes(parts) { // parts: [[цвет, доля], ...]
  var key = parts.map(function (p) { return p[0] + p[1]; }).join("|");
  if (patterns[key]) return "url(#" + patterns[key] + ")";
  var id = "lp" + Object.keys(patterns).length, W = 14, total = parts.reduce(function (a, p) { return a + p[1]; }, 0), x = 0;
  var body = parts.map(function (p) { var w = W * p[1] / total, r = '<rect x="' + x.toFixed(2) + '" y="0" width="' + (w + 0.3).toFixed(2) + '" height="' + W + '" fill="' + p[0] + '"/>'; x += w; return r; }).join("");
  // узоры лежат в одном скрытом SVG на странице: ссылки url(#…) работают из любого SVG документа
  var holder = document.getElementById("lens-defs");
  if (!holder) {
    document.body.insertAdjacentHTML("beforeend", '<svg id="lens-defs" width="0" height="0" style="position:absolute" aria-hidden="true"><defs></defs></svg>');
    holder = document.getElementById("lens-defs");
  }
  holder.firstChild.insertAdjacentHTML("beforeend", '<pattern id="' + id + '" patternUnits="userSpaceOnUse" width="' + W + '" height="' + W + '" patternTransform="rotate(45)">' + body + '</pattern>');
  patterns[key] = id;
  return "url(#" + id + ")";
}
// Чем закрасить регион в текущей линзе: {fill, text} или null — нет данных
function lensPaint(s) {
  var L0 = LENS[view.lens];
  if (!L0) return null;
  if (L0.kind === "race") {
    var c = s.k === "n" && censusOf(s.id);
    if (!c) return null;
    var r = c.race.map(function (p, i) { return [i, p]; }).sort(function (a, b) { return b[1] - a[1]; });
    var text = r.filter(function (q) { return q[1] >= 10; }).map(function (q) { return RACE[q[0]] + " " + q[1] + "%"; }).join(", ");
    if (r[0][1] >= 60 || r[1][1] < 20) return {fill: raceHex(r[0][0]), text: text};
    var mix = r.filter(function (q) { return q[1] >= 20; }).slice(0, 3);
    return {fill: stripes(mix.map(function (q) { return [raceHex(q[0]), q[1]]; })), text: text};
  }
  if (L0.kind === "build") {
    var b = (info(s).tags || {}).build;
    if (!b || !b.length) return null;
    var codes = b.map(function (x) { return BUILD[x] ? x : "other"; });
    var names = b.map(function (x) { return BUILD[x] || x; }).join(", ");
    if (codes.length === 1 || codes[0] === codes[1]) return {fill: BUILD_COLOR[codes[0]], text: names};
    return {fill: stripes([[BUILD_COLOR[codes[0]], 60], [BUILD_COLOR[codes[1]], 40]]), text: names};
  }
  if (L0.kind === "police") {
    var p = (info(s).tags || {}).police;
    if (!p) return null;
    var code = POLICE_COLOR[p] ? p : "other";
    return {fill: POLICE_COLOR[code], text: POLICE_NAME[code] === "другое" ? p : POLICE_NAME[code]};
  }
  var v = L0.get ? L0.get(s) : tagVal(s, L0.tag);
  if (v == null) return null;
  return {fill: L0.colors[v - L0.from], text: L0.label(v)};
}
function paintLens(el, s) {
  var p = view.lens ? lensPaint(s) : null;
  // у озёр и парков без данных оставляем их обычный цвет
  el.style.fill = !view.lens || (!p && s.k === "nat") ? "" : p ? p.fill : stripes([["#d9d9d9", 50], ["#f2f2f2", 50]]);
}
// Линза красит самые мелкие области: слой всех листьев лежит под регионами, а у регионов заливка прозрачная,
// так что видны границы раскрытой ветки, а цвет — по листьям
function syncLensLeaves() {
  if (!view.lens) { if (lensLayer) show(lensLayer, false); return; }
  lensReady = lensReady || ensureAll().then(function () {
    var feats = [];
    Object.keys(loaded).forEach(function (p) { loaded[p].features.forEach(function (f) { if (!idx[f.properties.id].n) feats.push(f); }); });
    lensLayer = L.geoJSON({type: "FeatureCollection", features: feats}, {pane: "lens", interactive: false, style: {className: "lensleaf"}});
  });
  lensReady.then(function () {
    if (!view.lens) return;
    show(lensLayer, true);
    lensLayer.eachLayer(function (l) { var el = l.getElement(); if (el) paintLens(el, {k: "n", id: l.feature.properties.id}); });
  });
}
// Лист под курсором внутри свёрнутого региона — для подсказки в режиме линзы
function inRing(x, y, ring) {
  var c = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function inFeat(f, x, y) {
  var g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some(function (p) { return inRing(x, y, p[0]) && !p.slice(1).some(function (h) { return inRing(x, y, h); }); });
}
function leafAt(id, ll) {
  return descendants(id).filter(function (d) { return !idx[d].n && featOf.n[d] && inFeat(featOf.n[d], ll.lng, ll.lat); })[0] || null;
}
function lensTip(s) {
  if (!view.lens) return "";
  var p = lensPaint(s);
  return "<small>" + esc(LENS[view.lens].name) + ": " + esc(p ? p.text : "нет данных") + "</small>";
}

// Легенда линзы: значения с образцами цвета; наведение показывает, что значит уровень
function legendItems() {
  var L0 = LENS[view.lens], out = [];
  if (L0.kind === "race") {
    RACE.forEach(function (n, i) { out.push([raceHex(i), n, "Больше 60% жителей — " + n + "."]); });
    out.push([stripes([[raceHex(1), 50], [raceHex(0), 30], [raceHex(2), 20]]), "смешанный",
      "Ни у одной группы нет 60%: полосы крупнейших групп (от 20%) в пропорции их долей. Цвета полос — как у групп выше."]);
  } else if (L0.kind === "build") {
    Object.keys(BUILD).forEach(function (k) { out.push([BUILD_COLOR[k], BUILD[k], ""]); });
    out.push([BUILD_COLOR.other, "особое", "Своё описание: рынки, вокзал, тюрьма и тому подобное — подробнее в карточке."]);
    out.push([stripes([[BUILD_COLOR.houses, 60], [BUILD_COLOR.apts, 40]]), "смешанная", "Два типа застройки: полосы обоих цветов, главный шире."]);
  } else if (L0.kind === "police") {
    Object.keys(POLICE_COLOR).forEach(function (k) { out.push([POLICE_COLOR[k], POLICE_NAME[k], POLICE_DESC[k]]); });
  } else {
    for (var v = L0.from; v < L0.from + L0.n; v++) out.push([L0.colors[v - L0.from], (L0.from === 0 ? v : v) + " · " + L0.label(v), L0.desc(v)]);
  }
  out.push([stripes([["#d9d9d9", 50], ["#f2f2f2", 50]]), "нет данных", L0.kind === "race" || view.lens === "wealth" ?
    "Здесь почти никто не живёт: рынки, склады, больницы, парки." : "Этот регион ещё не описан."]);
  return out;
}
var legendEl = null;
function renderLegend() {
  if (!legendEl) {
    legendEl = document.createElement("div"); legendEl.className = "lens-legend";
    document.querySelector(".map-side").appendChild(legendEl);
    L.DomEvent.disableClickPropagation(legendEl); L.DomEvent.disableScrollPropagation(legendEl);
  }
  legendEl.hidden = !view.lens;
  if (!view.lens) return;
  var items = legendItems();
  legendEl.innerHTML = '<b>' + esc(LENS[view.lens].name) + '</b><ul>' + items.map(function (q, i) {
    return '<li tabindex="0" data-i="' + i + '"><svg width="18" height="12" aria-hidden="true"><rect width="18" height="12" rx="2" style="fill:' + q[0] + '"/></svg>' + esc(q[1]) + '</li>';
  }).join("") + '</ul><p class="lg-tip">' + (window.matchMedia("(hover: none)").matches ? "Нажми" : "Наведи") + ' на уровень, чтобы узнать, что он значит.</p>';
  var tip = legendEl.querySelector(".lg-tip");
  legendEl.querySelectorAll("li").forEach(function (li) {
    function on() { var q = items[+li.getAttribute("data-i")]; tip.innerHTML = "<b>" + esc(q[1]) + ".</b> " + esc(q[2] || ""); }
    li.addEventListener("mouseenter", on); li.addEventListener("focus", on); li.addEventListener("click", on);
  });
}
function setLens(k) {
  view.lens = LENS[k] ? k : ""; store(VIEW_KEY, JSON.stringify(view));
  document.getElementById("lens").value = view.lens;
  map.getContainer().classList.toggle("lensed", !!view.lens);
  refreshStyles(); renderLegend();
}

// ---------- DART ----------
// Линии поездов и станции весны 2005 года поверх карты (data/geo/dart.geojson, сборка — tools/dart.py) и окошко справки
var DART_LINE = {red: "Красная линия: Уэстморленд — Паркер-роуд", blue: "Синяя линия: Ледбеттер — Даунтаун-Гарленд",
  shared: "Красная и синяя линии вместе: через центр от 8-й и Коринт до Мокингберда", tre: "TRE, пригородный поезд: Юнион-Стейшн — Форт-Уэрт"};
var DART_CODE = {R: "красная", B: "синяя", T: "TRE"};
var DART_TEXT = [
  "DART — городской транспорт Далласа и соседних пригородов: автобусы и две линии лёгкого метро, красная и синяя. В центре поезда идут прямо по улице, дальше — по своим путям, а под Центральным шоссе — в тоннеле.",
  "Днём поезд приходит каждые 10 минут, вечером раз в 20. С часу ночи до пяти утра поездов нет, только редкие автобусы и такси.",
  "Турникетов нет: билет берут в автомате на платформе, контролёры проверяют выборочно. На станциях и в поездах дежурит своя полиция DART, но камеры есть не везде, а ночные платформы на окраинах пустые и тёмные.",
  "TRE — пригородный поезд до Форт-Уэрта. По Макинни-авеню в Аптауне катается старинный трамвай M-Line."];
var dartLayer = null, dartReady = null, dartEl = null;
function dartLayers(fc) {
  var g = L.layerGroup(), lines = fc.features.filter(function (f) { return f.properties.kind === "line"; });
  function draw(f, cls, tip) {
    var l = L.geoJSON(f, {pane: "dart", interactive: !!tip, style: {className: cls}});
    if (tip) l.bindTooltip(tip, {sticky: true, direction: "top", className: "tip", offset: [0, -6]});
    l.addTo(g);
  }
  lines.forEach(function (f) { draw(f, "dart-case" + (f.properties.tunnel ? " dart-tun" : "")); });
  lines.forEach(function (f) {
    var p = f.properties, t = (p.tunnel ? " dart-tun" : ""),
      tip = esc(DART_LINE[p.line]) + (p.tunnel ? "<small>Под землёй: тоннель под Центральным шоссе, около пяти километров</small>" : "");
    if (p.line === "shared") { draw(f, "dart-red" + t); draw(f, "dart-blue dart-dash" + t, tip); }
    else draw(f, "dart-" + p.line + t, tip);
  });
  fc.features.forEach(function (f) {
    var p = f.properties;
    if (p.kind !== "station") return;
    var c = f.geometry.coordinates, big = p.lines.length > 1;
    L.circleMarker([c[1], c[0]], {pane: "dart", radius: big ? 6.5 : 4.5, className: "dart-st" + (big ? " big" : "")})
      .bindTooltip(function () { return "<b>" + esc(p.name) + "</b><small>" + esc(p.lines.split("").map(function (x) { return DART_CODE[x]; }).join(", ") +
        (p.en !== p.name ? " · " + p.en : "")) + "</small><span>" + esc(p.note) + "</span>" + tripTip({k: "st"}, [c[1], c[0]]); }, {direction: "top", className: "tip dart-tip", offset: [0, -6]})
      .on("click", function (e) { L.DomEvent.stopPropagation(e); e.target.openTooltip(); })
      .addTo(g);
  });
  return g;
}
function renderDartBox() {
  if (!dartEl) {
    dartEl = document.createElement("details"); dartEl.className = "dart-box"; dartEl.open = map.getSize().x >= 600;
    document.querySelector(".map-side").appendChild(dartEl);
    L.DomEvent.disableClickPropagation(dartEl); L.DomEvent.disableScrollPropagation(dartEl);
    var sw = function (cls) { return '<svg width="22" height="10" aria-hidden="true"><line x1="2" y1="5" x2="20" y2="5" class="' + cls + '"/></svg>'; };
    dartEl.innerHTML = "<summary><b>DART</b> — поезда весной 2005</summary>" +
      '<p class="hours"><b>Метро:</b> каждый день примерно с 5:00 до 1:00 ночи.<br><b>TRE:</b> по будням примерно с 5:30 до 23:00, в субботу реже, в воскресенье не ходит.</p>' + DART_TEXT.map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("") +
      '<ul><li>' + sw("dart-red") + 'красная линия</li><li>' + sw("dart-blue") + 'синяя линия</li><li>' + sw("dart-red") .replace("</svg>", '<line x1="2" y1="5" x2="20" y2="5" class="dart-blue dart-dash"/></svg>') +
      'обе линии</li><li>' + sw("dart-tre") + 'TRE до Форт-Уэрта</li><li>' + sw("dart-red dart-tun") + 'под землёй</li>' +
      '<li><svg width="22" height="10" aria-hidden="true"><circle cx="11" cy="5" r="4" class="dart-st"/></svg>станция — наведи, чтобы узнать подробнее</li></ul>';
  }
  dartEl.hidden = !view.dart;
}
function setDart(on) {
  view.dart = !!on; store(VIEW_KEY, JSON.stringify(view));
  document.getElementById("dart-tog").checked = view.dart;
  renderDartBox();
  if (!view.dart) { if (dartLayer) show(dartLayer, false); return; }
  dartReady = dartReady || fetch(GEO + "dart.geojson").then(function (r) { if (!r.ok) throw new Error("dart"); return r.json(); })
    .then(function (fc) { dartLayer = dartLayers(fc); });
  dartReady.then(function () { show(dartLayer, view.dart); });
}

// ---------- карта ----------
// Ускорения Leaflet. Колесо: шаги, пришедшие во время анимации зума, Leaflet выбрасывает, и карта «залипает» —
// копим их и применяем, как только анимация кончится. Проекция: меркатор каждой вершины считается один раз,
// при зуме остаётся умножение (раньше на каждом шаге зума заново считались синусы и логарифмы всех вершин).
(function () {
  var W = L.Map.ScrollWheelZoom.prototype, perform = W._performZoom;
  W._performZoom = function () {
    if (this._map._animatingZoom) { this._timer = setTimeout(L.Util.bind(this._performZoom, this), 30); return; }
    perform.call(this);
  };
  L.Polyline.prototype._projectLatlngs = function (latlngs, result, bounds) {
    var i;
    if (!(latlngs[0] instanceof L.LatLng)) { for (i = 0; i < latlngs.length; i++) this._projectLatlngs(latlngs[i], result, bounds); return; }
    var m = this._map, crs = m.options.crs, t = crs.transformation, s = crs.scale(m._zoom), o = m.getPixelOrigin(), ring = new Array(latlngs.length);
    for (i = 0; i < latlngs.length; i++) {
      var ll = latlngs[i], p = ll._m || (ll._m = crs.projection.project(ll));
      ring[i] = new L.Point(Math.round(s * (t._a * p.x + t._b)) - o.x, Math.round(s * (t._c * p.y + t._d)) - o.y);
      bounds.extend(ring[i]);
    }
    result.push(ring);
  };
})();

function buildMap() {
  map = L.map("map", {zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, minZoom: 9, maxZoom: 16, maxBounds: L.latLngBounds(BOUNDS).pad(0.15),
    maxBoundsViscosity: 0.8, attributionControl: true, doubleClickZoom: false, renderer: L.svg({padding: 0.5})});
  map.attributionControl.setPrefix(false).addAttribution('Геоданные © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, перепись США 2000');
  [["land", 200], ["lens", 290], ["reg", 300], ["green", 320], ["water", 330], ["nat", 340], ["city", 345], ["sel", 430], ["dart", 435], ["grid", 440], ["pins", 445], ["labels", 450]].forEach(function (p) {
    map.createPane(p[0]).style.zIndex = p[1];
  });
  ["lens", "city", "green", "water", "grid", "labels", "sel"].forEach(function (p) { map.getPane(p).style.pointerEvents = "none"; });

  L.rectangle(BOUNDS, {pane: "land", className: "land", interactive: false}).addTo(map);
  L.geoJSON(geo.green, {pane: "green", interactive: false, style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls !== "creek"; },
    style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  extra.creek = L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls === "creek"; }, style: {className: "creek"}});

  // озёра и парки: всегда видны и кликаются
  natLayer = L.geoJSON(geo.nature, {pane: "nat", style: function (f) { return {className: "nat k-" + f.properties.kind}; },
    onEachFeature: function (f, l) {
      var id = f.properties.id; featOf.nat[id] = f; layerOf.nat[id] = l;
      l.bindTooltip(function () { return esc(f.properties.name) + lensTip({k: "nat", id: id}) + tripTip({k: "nat", id: id}, [f.properties.ly, f.properties.lx]); }, {sticky: true, direction: "top", className: "tip", offset: [0, -6]});
      l.on("click", function (e) { L.DomEvent.stopPropagation(e); if (!placeAt(e.latlng)) select({k: "nat", id: id}, false); });
    }}).addTo(map);

  labelLayer = L.layerGroup().addTo(map);
  buildGrid();

  map.on("click", function (e) { placeAt(e.latlng); });
  map.on("contextmenu", function (e) { placeStart(); placeAt(e.latlng); }); // правый клик (на телефоне — долгое нажатие) ставит метку
  map.on("zoomend", refresh);
  map.on("moveend", placeLabels);
  home(false);
  window.vtmMap = map; // для отладки из консоли
}

function home(fly) {
  var b = map.getSize().x < 600 ? [[32.68, -97.0], [32.95, -96.62]] : [[32.62, -97.45], [33.02, -96.58]]; // на телефоне — Даллас
  if (fly) map.flyToBounds(b, {duration: 0.6}); else map.fitBounds(b);
}

// Слой детей узла (parent "" — верхний уровень). Файл грузится один раз.
function ensureKids(parent) {
  if (loaded[parent]) return Promise.resolve(loaded[parent]);
  return fetch(TREE + (parent || "_root") + ".geojson").then(function (r) { if (!r.ok) throw new Error(parent); return r.json(); }).then(function (fc) {
    loaded[parent] = fc;
    regLayer[parent] = L.geoJSON(fc, {pane: "reg", style: function (f) { return {className: regClass(f.properties.id, f.properties)}; },
      onEachFeature: function (f, l) { hook(f, l); }});
    return fc;
  });
}
function ensureAll() { // режим листьев: файлы детей всех узлов
  return Promise.all(parents().map(ensureKids));
}
function parents() { // все узлы с детьми, сверху вниз: глубже — поверх
  return [""].concat(Object.keys(idx).filter(function (id) { return idx[id].n; }).sort(function (a, b) { return idx[a].depth - idx[b].depth; }));
}
function ensurePath(ids) { // загрузить файлы для всех узлов пути по очереди
  return ids.reduce(function (p, id) { return p.then(function () { return ensureKids(id); }); }, ensureKids(""));
}

function regClass(id, p) {
  var x = idx[id];
  p = p || (featOf.n[id] ? featOf.n[id].properties : {});
  var parent = x.parent || "", focus = view.leaves || parent === (open.length ? open[open.length - 1] : "");
  return "reg d" + Math.min(x.depth, 3) + " t" + (p.tone || 0) + " s" + (p.shade || 0) +
    " k-" + (x.kind || "area") + (isOpen(id) ? " exp" : focus ? " focus" : " ctx") + (regionColor("n:" + id) ? " painted" : "");
}
function descendants(id) {
  var out = [];
  (kidsOf[id] || []).forEach(function (c) { out.push(c); out = out.concat(descendants(c)); });
  return out;
}

function hook(f, l) {
  var id = f.properties.id;
  featOf.n[id] = f; layerOf.n[id] = l;
  var leaf = null; // в линзе: лист под курсором, если регион свёрнут
  l.bindTooltip(function () {
    var closed = idx[id].n && !isOpen(id);
    var to = leaf || id;
    return esc(idx[id].name) + (leaf ? "<small>" + esc(idx[leaf].name) + "</small>" : "") + lensTip({k: "n", id: to}) + tripTip({k: "n", id: to}, [idx[to].ly, idx[to].lx]) +
      (closed ? '<small>двойной клик — что внутри</small>' : '');
  }, {sticky: true, direction: "top", className: "tip", offset: [0, -6]});
  l.on("mousemove", function (e) {
    var lf = view.lens && idx[id].n && !isOpen(id) && lensLayer ? leafAt(id, e.latlng) : null;
    if (lf !== leaf) { leaf = lf; if (l.getTooltip()) l.getTooltip().update(); }
  });
  l.on("click", function (e) { L.DomEvent.stopPropagation(e); if (!placeAt(e.latlng)) select({k: "n", id: id}, false); });
  l.on("dblclick", function (e) { L.DomEvent.stopPropagation(e); if (idx[id].n) expand(id); });
  l.on("mouseover", function () { var el = l.getElement(); if (el) el.classList.add("hov"); });
  l.on("mouseout", function () { var el = l.getElement(); if (el) el.classList.remove("hov"); });
}

function show(layer, on) { if (on) { if (!map.hasLayer(layer)) layer.addTo(map); } else if (map.hasLayer(layer)) map.removeLayer(layer); }

// Какие слои регионов на карте: верхний уровень и дети каждого раскрытого узла (глубже — поверх)
function syncLayers() {
  var want = view.leaves ? parents() : [""].concat(open);
  Object.keys(regLayer).forEach(function (p) { if (want.indexOf(p) < 0) show(regLayer[p], false); });
  want.forEach(function (p) { if (regLayer[p] && map.hasLayer(regLayer[p])) map.removeLayer(regLayer[p]); });
  want.forEach(function (p) { if (regLayer[p]) regLayer[p].addTo(map); });
  refreshStyles(); drawSel();
  syncCollapse();
}

// Раскрыть узел: только его ветка, остальные свёрнуты. Карта не двигается, кроме перехода по ссылке (fly).
function expand(id, fly) {
  if (!idx[id] || !idx[id].n || view.leaves) return;
  var path = ancestors(id).concat([id]);
  ensurePath(path).then(function () {
    open = path; syncLayers();
    var b = idx[id].bbox;
    if (fly) map.flyToBounds([[b[1], b[0]], [b[3], b[2]]], {padding: [30, 30], duration: 0.6});
    if (!sel || sel.k !== "n" || sel.id !== id) select({k: "n", id: id}, false); else { renderPanel(); syncHash(); }
    placeLabels();
  });
}
// Свернуть до уровня, где виден узел id (или всё, если id не задан)
function collapseTo(id) {
  open = id ? ancestors(id) : [];
  syncLayers(); placeLabels(); renderPanel(); syncHash();
}

// Всё, что зависит от масштаба
function refresh() {
  var z = map.getZoom(), el = map.getContainer();
  el.className = el.className.replace(/z\d+/g, "").replace(/\s+/g, " ").trim() + " z" + Math.floor(z);
  show(extra.creek, z >= 13);
  if (gridLabels) show(gridLabels, gridOn() && z >= 10.5);
  placeLabels();
}

// Подписи без наложения. Сначала выбранный регион, потом регионы раскрытой ветки (крупные раньше), потом соседи,
// потом озёра и парки. В DOM лежат только видимые подписи; ширина считается по тексту, без перерисовки страницы.
var measureCtx = document.createElement("canvas").getContext("2d");
var LBL = {top: [12.5, 700, 170, true], focus: [12.5, 650, 140, false], ctx: [11.5, 600, 130, false], nat: [11.5, 500, 120, false]};
function labelSize(x) {
  if (x.sz) return x.sz;
  var f = LBL[x.cls];
  measureCtx.font = f[1] + " " + f[0] + "px 'Golos Text', sans-serif";
  var txt = f[3] ? x.name.toUpperCase() : x.name, w = measureCtx.measureText(txt).width + (f[3] ? txt.length * f[0] * 0.08 : 0);
  x.sz = {w: Math.min(w, f[2]), h: Math.ceil(w / f[2]) * f[0] * 1.2};
  return x.sz;
}
var labelCache = {};
function labelList() {
  var list = [], last = open.length ? open[open.length - 1] : "";
  if (view.leaves) Object.keys(featOf.n).forEach(function (id) {
    var x = idx[id], key = id + "|focus";
    if (!x.n) list.push(labelCache[key] = labelCache[key] || {id: "n:" + id, name: x.name, ll: L.latLng(x.ly, x.lx), km2: x.km2, cls: "focus", rank: x.km2});
  });
  else [""].concat(open).forEach(function (p) {
    (kidsOf[p] || []).forEach(function (id) {
      if (open.indexOf(id) >= 0 || !featOf.n[id]) return;
      var x = idx[id], cls = p === last ? (p === "" ? "top" : "focus") : (p === "" ? "top" : "ctx");
      var key = id + "|" + cls;
      list.push(labelCache[key] = labelCache[key] || {id: "n:" + id, name: x.name, ll: L.latLng(x.ly, x.lx), km2: x.km2, cls: cls,
        rank: (p === last ? 1e6 : 0) + x.km2});
    });
  });
  geo.nature.features.forEach(function (f) {
    var p = f.properties, key = "nat:" + p.id;
    list.push(labelCache[key] = labelCache[key] || {id: key, name: p.name, ll: L.latLng(p.ly, p.lx), km2: p.km2, cls: "nat", kind: p.kind, rank: -1e6 + p.km2});
  });
  return list.sort(function (a, b) { return b.rank - a.rank; });
}
function placeLabels() {
  if (!labelLayer) return;
  var z = map.getZoom(), placed = [], want = {}, vis = map.getBounds().pad(0.1);
  var pxPerKm = 256 * Math.pow(2, z) / (40075 * Math.cos(32.8 * Math.PI / 180));
  var selId = sel ? skey(sel) : null, list = labelList();
  if (selId) list = list.filter(function (x) { return x.id === selId; }).concat(list.filter(function (x) { return x.id !== selId; }));
  for (var i = 0; i < list.length && placed.length < 300; i++) {
    var x = list[i];
    if (!vis.contains(x.ll)) continue;
    var side = Math.sqrt(x.km2) * pxPerKm, sz = labelSize(x);
    if (x.id !== selId && (side < 26 || (x.cls === "nat" && side < sz.w * 0.7))) continue;
    var p = map.latLngToLayerPoint(x.ll), hit = false;
    var b = [p.x - sz.w / 2 - 4, p.y - sz.h / 2 - 2, p.x + sz.w / 2 + 4, p.y + sz.h / 2 + 2];
    for (var j = 0; j < placed.length; j++) {
      var o = placed[j];
      if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) { hit = true; break; }
    }
    if (hit) continue;
    placed.push(b); want[x.id + "|" + x.cls] = x;
  }
  labelLayer.eachLayer(function (m) { if (!want[m.lid]) labelLayer.removeLayer(m); else delete want[m.lid]; });
  Object.keys(want).forEach(function (k) {
    var x = want[k], m = L.marker(x.ll, {pane: "labels", interactive: false, keyboard: false,
      icon: L.divIcon({className: "lbl lbl-" + x.cls + (x.kind ? " lk-" + x.kind : ""), html: "<span>" + esc(x.name) + "</span>", iconSize: null})});
    m.lid = k; labelLayer.addLayer(m);
  });
}

function gridOn() { return load("vtm-dallas-2005-map.grid") === "1"; }
function buildGrid() {
  gridLayer = L.layerGroup(); gridLabels = L.layerGroup();
  ["city", "fw"].forEach(function (b) {
    var G = GRIDS[b], dx = (G.e - G.w) / G.cols, dy = (G.n - G.s) / G.rows;
    for (var c = 0; c <= G.cols; c++) gridLayer.addLayer(L.polyline([[G.n, G.w + c * dx], [G.s, G.w + c * dx]], {pane: "grid", className: "grid", interactive: false}));
    for (var r = 0; r <= G.rows; r++) gridLayer.addLayer(L.polyline([[G.n - r * dy, G.w], [G.n - r * dy, G.e]], {pane: "grid", className: "grid", interactive: false}));
    for (c = 0; c < G.cols; c++) for (r = 0; r < G.rows; r++)
      gridLabels.addLayer(L.marker([G.n - r * dy - dy * 0.12, G.w + c * dx + dx * 0.1], {pane: "grid", interactive: false, keyboard: false,
        icon: L.divIcon({className: "lbl lbl-g", html: "<span>" + (b === "fw" ? "ФУ " : "") + LET[c] + (r + 1) + "</span>", iconSize: null})}));
  });
  var t = document.getElementById("grid-tog");
  t.checked = gridOn();
  if (t.checked) gridLayer.addTo(map);
  t.addEventListener("change", function () {
    store("vtm-dallas-2005-map.grid", t.checked ? "1" : "0");
    show(gridLayer, t.checked);
    refresh(); renderPanel();
  });
}

function clearSel() {
  sel = null; editing = false; draft = null; isNewPin = false; if (selLayer) map.removeLayer(selLayer); selLayer = null; drawPins();
  map.getContainer().classList.remove("has-sel");
  renderPanel(); syncHash(); placeLabels();
}

// Выбрать регион или озеро. Регион, которого сейчас не видно, раскрывает путь к себе.
function select(s, fly) {
  if (s.k === "n") {
    if (!idx[s.id]) return;
    var anc = ancestors(s.id);
    var visible = view.leaves || anc.every(function (a, i) { return open[i] === a; });
    if (!visible || !featOf.n[s.id]) {
      ensurePath(anc).then(function () { open = anc; syncLayers(); select(s, fly); });
      return;
    }
  } else if (!featOf[s.k][s.id]) return;
  placeStop(); sel = s; editing = false; status = ""; draft = null; isNewPin = false; noteSlot = ""; confirmDel = false;
  drawSel(); drawPins();
  if (fly) {
    var b = layerOf[s.k][s.id].getBounds();
    map.flyTo(b.getCenter(), Math.min(14, Math.max(9.5, map.getBoundsZoom(b, false, L.point(60, 60)))), {duration: 0.6});
  }
  refresh(); renderPanel(); syncHash();
  if (window.matchMedia("(max-width:900px)").matches && !fly) { try { panel.scrollIntoView({behavior: "smooth", block: "start"}); } catch (_) {} }
}

// Подсветка выбранного; раскрытый регион подсвечивается только контуром, чтобы были видны его части
function drawSel() {
  if (selLayer) map.removeLayer(selLayer);
  selLayer = null;
  if (!sel || sel.k === "pin") { map.getContainer().classList.remove("has-sel"); return; }
  var cls = "selpath" + (sel.k === "n" && isOpen(sel.id) ? " selopen" : "");
  selLayer = L.geoJSON(featOf[sel.k][sel.id], {pane: "sel", interactive: false, style: {className: cls}}).addTo(map);
  map.getContainer().classList.add("has-sel");
}

function refreshStyles() {
  Object.keys(layerOf.n).forEach(function (id) {
    var el = layerOf.n[id].getElement();
    if (el) { el.setAttribute("class", regClass(id) + " leaflet-interactive"); el.style.fill = regionColor("n:" + id); }
  });
  syncLensLeaves();
  Object.keys(layerOf.nat).forEach(function (id) {
    var el = layerOf.nat[id].getElement(), c = regionColor("nat:" + id);
    if (el) { el.setAttribute("class", "nat k-" + featOf.nat[id].properties.kind + (c ? " painted" : "") + " leaflet-interactive"); el.style.fill = c; if (view.lens) paintLens(el, {k: "nat", id: id}); }
  });
}

// ---------- карточка региона ----------
var INTRO = '<div class="pmeta"><span>Даллас, Форт-Уэрт и пригороды · весна 2005</span></div><h2>Карта районов</h2>' +
  '<div class="pdet"><p>Сначала на карте только города и пригороды. Нажми на регион, и здесь откроется его описание.</p>' +
  '<p>Чтобы заглянуть внутрь, дважды щёлкни по региону или нажми «Раскрыть» в карточке: он разделится на части, а те — на районы. Раскрыта всегда одна ветка; «Свернуть всё» в шапке возвращает общий вид.</p>' +
  '<p>Озёра, парки и заповедники видны всегда, их тоже можно открыть.</p>' +
  '<p>«Линза» в шапке перекрашивает карту по одному признаку: достаток, кто живёт, опасность улиц, свидетели, ночная жизнь, застройка, полиция. Что значит цвет — в легенде в углу карты.</p>' +
  '<p>Кнопка «DART» показывает поезда 2005 года: линии лёгкого метро, пригородный поезд до Форт-Уэрта и станции.</p>' +
  '<p>Метки — точки на карте со своим значком, цветом, тегами и текстом. Поставить: «Поставить метку» в карточке региона и клик по карте, или правый клик по карте. К региону можно добавить заметку и перекрасить его своим цветом.</p>' +
  '<p>Метки лежат в слотах — меню «Метки» в шапке. Слот можно скрыть, сохранить в файл и загрузить у другого игрока или мастера: загрузка заменяет только этот слот. Всё хранится только в твоём браузере.</p></div>' +
  '<div class="about"><div class="legend"><span><i class="sw" style="background:var(--water)"></i>озеро</span><span><i class="sw" style="background:var(--park-strong)"></i>природная зона</span></div>' +
  '<p><a href="review.html">Список всех регионов</a> — с названиями, откуда они взялись, и ссылками на Google Maps для сверки.</p>' +
  '<p>Подложка — по OpenStreetMap и переписи США 2000 года, всё новее весны 2005-го мы стараемся убирать. Границы регионов игровые: примерно по городской черте и крупным дорогам, но сглажены.</p></div>';

function crumbs(id) {
  return ancestors(id).map(function (a) { return '<a href="#n/' + esc(a) + '" data-crumb="' + esc(a) + '">' + esc(idx[a].name) + '</a>'; });
}

function renderPanel() {
  if (!sel) { panel.innerHTML = INTRO; return; }
  if (sel.k === "pin") { renderPinPanel(); return; }
  var s = sel, x = info(s);
  var node = s.k === "n" ? idx[s.id] : null, np = s.k === "nat" ? featOf.nat[s.id].properties : null;
  var name = node ? node.name : np.name, km2 = node ? node.km2 : np.km2, ll = node ? [node.ly, node.lx] : [np.ly, np.lx];
  var meta = '<span>' + (node ? kindLabel(s.id) : NATKIND[np.kind]) + '</span>' + (node ? crumbs(s.id).join('<span>›</span>') : '');

  if (editing) { renderNoteForm(s, name, meta); return; }

  var act = activeSlot(), mineBlock = regionNotes(skey(s)).map(function (q) {
    return '<div class="mine"><h3>' + (q.r.color ? '<i class="sw" style="background:' + q.r.color + '"></i>' : "") + esc(q.slot.name) +
      '<button type="button" class="linkbtn" data-note="' + esc(q.slot.id) + '">изменить</button></h3>' +
      tagChips(q.slot, q.r.tags) + (q.r.text ? '<div class="md">' + md(q.r.text) + '</div>' : "") + '</div>';
  }).join("");
  // своего текста нет — показываем описание ближайшего предка, у которого он есть
  var body = (x.details || "").trim() ? '<div class="pdet">' + md(x.details) + '</div>' : "";
  if (!body && node) {
    var up = ancestors(s.id).reverse().filter(function (a) { return ((text.nodes[a] || {}).details || "").trim(); })[0];
    body = up ? '<div class="inherit"><h3>' + esc(kindLabel(up)) + ' «' + esc(idx[up].name) + '»</h3>' + md(text.nodes[up].details) + '</div>'
      : '<p class="hint">Описания пока нет.</p>';
  }
  if (!body) body = '<p class="hint">Описания пока нет.</p>';
  var opened = node && open.indexOf(s.id) >= 0, kids = "";
  if (node && node.n) {
    var list = (kidsOf[s.id] || []).slice().sort(function (a, b) { return idx[a].name.localeCompare(idx[b].name, "ru"); });
    kids = '<div class="kids"><h3>Внутри · ' + list.length + '</h3><ul>' + list.map(function (id) {
      return '<li><button type="button" data-go="n:' + esc(id) + '">' + esc(idx[id].name) + '</button></li>'; }).join("") + '</ul></div>';
  }
  var cells = ["core", "city", "fw"].map(function (b) { var c = gridCell(b, ll[0], ll[1]); return c ? GRIDS[b].label + " " + c : null; }).filter(Boolean);
  panel.innerHTML =
    '<div class="pmeta">' + meta + '</div>' +
    '<h2>' + esc(name) + '</h2>' +
    '<div class="pmeta" style="margin-bottom:12px"><span>≈ ' + String(km2).replace(".", ",") + ' км²</span>' +
    (cells.length && gridOn() ? '<span>старая сетка: ' + esc(cells.join(", ")) + '</span>' : '') + '</div>' + tripLine(s, ll) +
    tagsBlock(s) + (x.summary ? '<p class="psum">' + esc(x.summary) + '</p>' : "") + body +
    (x.more && x.more.trim() ? '<details class="pmore" id="p-more"' + (moreOpen[skey(s)] ? " open" : "") + '><summary>Подробнее</summary><div class="pdet">' + md(x.more) + '</div></details>' : "") +
    (x.notes && x.notes.trim() ? '<div class="notes"><h3>Заметки мастера</h3><div class="md">' + md(x.notes) + '</div></div>' : "") +
    mineBlock +
    '<div class="actions">' +
    (node && node.n && !view.leaves ? (opened ? '<button class="btn primary" type="button" id="p-fold">Свернуть</button>' : '<button class="btn primary" type="button" id="p-open">Раскрыть</button>') : '') +
    '<button class="btn" type="button" id="p-note">' + (act && act.regions[skey(s)] ? "Изменить заметку" : "Заметка к региону") + '</button>' +
    '<button class="btn" type="button" id="p-pin" title="Потом нажми на карту, где поставить точку">Поставить метку</button>' +
    '<button class="btn" type="button" id="p-show">Показать на карте</button>' + refBtn(s) +
    (status ? '<span class="status">' + esc(status) + '</span>' : "") + '</div>' + kids;
  bindTags();
  var pm = document.getElementById("p-more");
  if (pm) pm.addEventListener("toggle", function () { if (pm.open) moreOpen[skey(s)] = 1; else delete moreOpen[skey(s)]; });
  var po = document.getElementById("p-open"); if (po) po.addEventListener("click", function () { expand(s.id); });
  var pf = document.getElementById("p-fold"); if (pf) pf.addEventListener("click", function () { collapseTo(s.id); });
  function note(id) { editing = true; noteSlot = id || ""; status = ""; confirmDel = false; renderPanel(); var t = document.getElementById("f-text"); if (t) t.focus(); }
  document.getElementById("p-note").addEventListener("click", function () { note(""); });
  panel.querySelectorAll("[data-note]").forEach(function (b) { b.addEventListener("click", function () { note(b.getAttribute("data-note")); }); });
  document.getElementById("p-pin").addEventListener("click", placeStart);
  document.getElementById("p-show").addEventListener("click", function () { select(s, true); });
  bindRef(s);
}
function refBtn(s) {
  return '<button class="btn" type="button" id="p-ref" title="' + (isRef(s) ? "Больше не считать расстояния отсюда" : "Считать расстояния в других карточках отсюда") + '">' +
    (isRef(s) ? "Убрать отсчёт" : "Отсчёт отсюда") + '</button>';
}
function bindRef(s) { var b = document.getElementById("p-ref"); if (b) b.addEventListener("click", function () { setRef(s); }); }

panel.addEventListener("click", function (e) {
  var c = e.target.closest("[data-crumb]");
  if (c) { // крошка: свернуть до этого региона и выбрать его
    e.preventDefault();
    var id = c.getAttribute("data-crumb");
    collapseTo(id); select({k: "n", id: id}, false);
    return;
  }
  var t = e.target.closest("[data-go]"); if (!t) return;
  e.preventDefault();
  var g = t.getAttribute("data-go").split(":");
  select({k: g[0], id: g.slice(1).join(":")}, false);
});

// ---------- поиск ----------
// Одна строка ищет по всему: сначала названия, потом теги, потом тексты описаний; в каждом свои и чужие метки и заметки.
// Слова сравниваются без окончаний («тюрьма» найдёт «тюрьмы», «тюрьмой»), длинные — ещё и с одной опечаткой («тюрем»).
function norm(s) { return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[-‐\s]+/g, " "); }
var WORD = /[a-zа-я0-9]+/g;
var ENDING = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|иях|ях|ах|ией|ей|ой|ий|ый|ая|яя|ое|ее|ую|юю|ом|ем|ам|ям|ов|ев|ы|и|а|я|о|е|у|ю|ь|й)$/;
function stem(w) {
  if (w.length < 4) return w;
  var s = w.replace(ENDING, "");
  return s.length >= 3 ? s : w.slice(0, 3);
}
// Поле поиска: слово → [где впервые встретилось, сколько раз]
function wordsOf(s) {
  // норма без склейки пробелов, чтобы позиции совпадали с исходным текстом
  var t = String(s || "").toLowerCase().replace(/ё/g, "е"), out = {}, m;
  WORD.lastIndex = 0;
  while ((m = WORD.exec(t))) { var w = out[m[0]]; if (w) w[1]++; else out[m[0]] = [m.index, 1]; }
  return out;
}
// Расстояние Левенштейна, но не больше 2: дальше нам неважно
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  var prev = [], cur, i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Как слово запроса попало в поле: 2 — точно, 1 — с опечаткой, 0 — нет. Совпавшее слово кладём в hit.
function matchWord(q, words, hit) {
  var st = stem(q), fuzzy = st.length >= 5, best = 0;
  for (var w in words) {
    if (w.indexOf(q.length < 3 ? q : st) === 0) { hit.w = w; hit.at = words[w][0]; hit.n = (hit.n || 0) + words[w][1]; best = 2; }
    else if (best < 1 && fuzzy && w[0] === st[0] && w.length >= st.length - 1) {
      for (var k = st.length - 1; k <= st.length + 1; k++) if (lev(st, w.slice(0, k)) <= 1) { hit.w = w; hit.at = words[w][0]; best = 1; break; }
    }
  }
  return best;
}
function snippet(src, at, len) {
  var a = Math.max(0, at - 40), b = Math.min(src.length, at + len + 60);
  while (a > 0 && /\S/.test(src[a - 1])) a--;
  while (b < src.length && /\S/.test(src[b])) b++;
  return (a > 0 ? "…" : "") + esc(src.slice(a, at)) + "<mark>" + esc(src.slice(at, at + len)) + "</mark>" + esc(src.slice(at + len, b)) + (b < src.length ? "…" : "");
}
function setupSearch() {
  var q = document.getElementById("q"), box = document.getElementById("results"), base = null;
  // Тексты карты не меняются: собираем их один раз, при первом поиске
  function field(src) { src = plain(src); return {src: src, words: wordsOf(src)}; }
  function regionTags(s) {
    // в теги идут названия клеток и значения («Полиция — шериф»), в текст — пояснения к ним
    var keep = [tagTexts, tagCells], lab = [], txt = [];
    tagsBlock(s);
    tagCells.forEach(function (q) {
      var v = q[2] || q[1].replace(/<[^>]+>/g, "");
      lab.push(q[0] + (v ? " — " + v : "")); if (q[3]) txt.push(q[3]);
    });
    tagTexts = keep[0]; tagCells = keep[1];
    return [lab.join(". "), txt.join(" ")];
  }
  function buildBase() {
    var out = [];
    function add(s, name, sub, lv) {
      var x = info(s), t = regionTags(s), n = (x.tags || {}).notes || {};
      out.push({k: s.k, id: s.id, name: name, sub: sub, lv: lv, key: s.k + ":" + s.id,
        f: [field(name), field(t[0]), field([x.summary, x.details, x.more, x.notes, t[1]].concat(Object.keys(n).map(function (k) { return n[k]; })).filter(Boolean).join("\n\n"))]});
    }
    Object.keys(idx).forEach(function (id) {
      var a = ancestors(id);
      add({k: "n", id: id}, idx[id].name, kindLabel(id).toLowerCase() + (a.length ? " · " + idx[a[a.length - 1]].name : ""), idx[id].depth);
    });
    geo.nature.features.forEach(function (f) { add({k: "nat", id: f.properties.id}, f.properties.name, NATKIND[f.properties.kind].toLowerCase(), 4); });
    return out;
  }
  // Метки и заметки меняются, их собираем на каждый поиск: только из видимых слотов
  function marksItems() {
    var out = [], notes = {};
    allSlots().filter(function (s) { return s.on; }).forEach(function (s) {
      s.pins.forEach(function (p) {
        out.push({k: "pin", slot: s.id, id: p.id, name: p.title || "Метка", sub: "метка · " + s.name, lv: 5, pin: p,
          f: [field(p.title || ""), field(p.tags.join(". ")), field(p.text || "")]});
      });
      Object.keys(s.regions).forEach(function (k) {
        var r = s.regions[k], o = notes[k] || (notes[k] = {tags: [], text: []});
        o.tags = o.tags.concat(r.tags); if (r.text) o.text.push(r.text);
      });
    });
    return {pins: out, notes: notes};
  }
  function find(v) {
    // одна-две буквы ищем только в названиях: в текстах такое найдётся везде
    var qs = norm(v).match(WORD) || [], m = marksItems(), hits = [], nf = norm(v).trim().length < 3 ? 1 : 3;
    if (!qs.length) return hits;
    base.concat(m.pins).forEach(function (x) {
      var f = x.f;
      var u = m.notes[x.key];
      if (u) f = [f[0], field(f[1].src + ". " + u.tags.join(". ")), field(f[2].src + (f[2].src ? "\n\n" : "") + u.text.join("\n\n"))];
      // каждое слово запроса ищем сначала в названии, потом в тегах, потом в тексте; ярус — худшее из найденных
      var tier = 0, fuzzy = false, n = 0, show = null;
      for (var i = 0; i < qs.length; i++) {
        var got = 0, hit = {};
        for (var j = 0; j < nf && !got; j++) { hit = {}; got = matchWord(qs[i], f[j].words, hit); if (got) { tier = Math.max(tier, j); if (j && (!show || j >= show.j)) show = {f: f[j], hit: hit, j: j}; } }
        // название ищем и как подстроку: «эллум» в «Дип-Эллум»
        if (!got && norm(x.name).indexOf(norm(v).trim()) >= 0) { got = 2; }
        if (!got) return;
        if (got === 1) fuzzy = true;
        n += hit.n || 0;
      }
      hits.push({x: x, tier: tier, fuzzy: fuzzy, n: n, show: tier ? show : null, at: norm(x.name).indexOf(qs[0])});
    });
    return hits.sort(function (a, b) {
      return a.tier - b.tier || a.fuzzy - b.fuzzy ||
        (a.tier ? b.n - a.n : (a.at < 0 ? 99 : a.at) - (b.at < 0 ? 99 : b.at)) || a.x.lv - b.x.lv || a.x.name.length - b.x.name.length;
    }).slice(0, 30);
  }
  // Наведение на результат обводит его на карте; карта при этом не двигается
  var hov = null, hovKey = "";
  function unhover() { hovKey = ""; if (hov) { map.removeLayer(hov); hov = null; } }
  function hide() { box.hidden = true; unhover(); }
  function hover(b) {
    var k = b.getAttribute("data-k"), id = b.getAttribute("data-id"), key = k + ":" + id, opt = {pane: "sel", interactive: false, style: {className: "hovpath"}};
    if (key === hovKey) return;
    unhover(); hovKey = key;
    function draw(layer) { if (hovKey === key) hov = layer.addTo(map); }
    if (k === "pin") { var p = pinOf({slot: b.getAttribute("data-slot"), id: id}); if (p) draw(L.circleMarker(p.ll, {pane: "sel", interactive: false, radius: 20, className: "hovpath"})); }
    else if (k === "nat") draw(L.geoJSON(featOf.nat[id], opt));
    else ensureKids(idx[id].parent || "").then(function (fc) {
      var f = fc.features.filter(function (f) { return f.properties.id === id; })[0];
      if (f) draw(L.geoJSON(f, opt));
    });
  }
  function showRes() {
    var v = q.value.trim();
    if (!v) { hide(); return; }
    if (!base) base = buildBase();
    var hits = find(v);
    unhover();
    box.innerHTML = hits.length ? hits.map(function (h) {
      var x = h.x, sn = h.show ? snippet(h.show.f.src, h.show.hit.at, h.show.hit.w.length) : "";
      return '<button type="button" data-k="' + x.k + '" data-id="' + esc(x.id) + '"' + (x.slot ? ' data-slot="' + esc(x.slot) + '"' : "") + '>' +
        (x.pin ? pinHtml(x.pin) : "") + esc(x.name) + '<small>' + esc(x.sub) + '</small>' + (sn ? '<span class="snip">' + sn + '</span>' : "") + '</button>';
    }).join("")
      : '<button type="button" disabled>Ничего не нашлось</button>';
    box.hidden = false;
  }
  q.addEventListener("input", showRes);
  q.addEventListener("focus", showRes);
  q.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { var b = box.querySelector("button[data-id]"); if (b) b.click(); }
    if (e.key === "Escape") { hide(); q.blur(); }
  });
  box.addEventListener("mouseover", function (e) { var b = e.target.closest("button[data-id]"); if (b) hover(b); });
  box.addEventListener("focusin", function (e) { var b = e.target.closest("button[data-id]"); if (b) hover(b); });
  box.addEventListener("mouseleave", unhover);
  box.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-id]"); if (!b) return;
    hide(); q.value = "";
    if (b.getAttribute("data-k") === "pin") selectPin(b.getAttribute("data-slot"), b.getAttribute("data-id"), true);
    else select({k: b.getAttribute("data-k"), id: b.getAttribute("data-id")}, true);
  });
  document.addEventListener("click", function (e) { if (!e.target.closest(".search")) hide(); });
}

// ---------- карточка метки и формы ----------
// Поле тегов: теги вписываются вручную (Enter или запятая), у каждого свой цвет; цвет тега общий для всего слота
function tagEdHtml(slot) {
  return '<div class="taged"><span class="tlist" id="f-tlist"></span><input id="f-tagin" list="f-taglist" placeholder="новый тег, Enter" autocomplete="off">' +
    '<input type="color" id="f-tagcol" title="Цвет нового тега">' +
    '<datalist id="f-taglist">' + Object.keys(slot.tags).map(function (t) { return '<option value="' + esc(t) + '">'; }).join("") + '</datalist></div>';
}
function bindTagEd(slot, st, onchange) { // st: {tags: [], colors: {}}
  var box = document.getElementById("f-tlist"), inp = document.getElementById("f-tagin"), sq = document.getElementById("f-tagcol"), picked = false;
  function col(t) { return st.colors[t] || slot.tags[t] || PALETTE[(Object.keys(slot.tags).length + st.tags.indexOf(t)) % PALETTE.length]; }
  function nextColor() { // следующий цвет палитры, которого ещё нет у тегов слота и формы
    var used = Object.keys(slot.tags).map(function (t) { return slot.tags[t]; }).concat(Object.keys(st.colors).map(function (t) { return st.colors[t]; }));
    return PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[(used.length) % PALETTE.length];
  }
  function resetSq() { picked = false; sq.value = nextColor(); }
  function draw() {
    box.innerHTML = st.tags.map(function (t, i) {
      return '<span class="tchip ed" style="--c:' + col(t) + '"><input type="color" value="' + col(t) + '" data-i="' + i + '" title="Цвет тега «' + esc(t) + '»">' +
        esc(t) + '<button type="button" data-x="' + i + '" aria-label="Убрать тег ' + esc(t) + '">×</button></span>';
    }).join("");
  }
  function add() {
    var v = inp.value.replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    inp.value = "";
    if (!v || st.tags.indexOf(v) >= 0 || st.tags.length >= 12) return;
    st.tags.push(v); st.colors[v] = slot.tags[v] && !picked ? slot.tags[v] : sq.value; resetSq(); draw(); onchange();
  }
  // знакомый тег подставляет свой цвет в квадратик, пока игрок не выбрал цвет сам
  inp.addEventListener("input", function () { var v = inp.value.trim(); if (!picked) sq.value = slot.tags[v] || st.colors[v] || nextColor(); });
  sq.addEventListener("input", function () { picked = true; });
  inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !inp.value && st.tags.length) { st.tags.pop(); draw(); onchange(); }
  });
  box.addEventListener("click", function (e) { var b = e.target.closest("[data-x]"); if (b) { st.tags.splice(+b.getAttribute("data-x"), 1); draw(); onchange(); } });
  resetSq();
  box.addEventListener("input", function (e) {
    var i = e.target.getAttribute("data-i"); if (i == null) return;
    st.colors[st.tags[+i]] = e.target.value; e.target.parentNode.style.setProperty("--c", e.target.value); onchange();
  });
  draw();
  return {flush: add, color: col};
}
function slotOptions(cur) {
  return marks.slots.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === cur ? " selected" : "") + '>' + esc(s.name) + '</option>'; }).join("");
}
function confirmBtn(id, label) {
  return confirmDel ? '<button class="btn danger" type="button" id="' + id + '2">Да, удалить</button><button class="btn" type="button" id="' + id + '0">Не удалять</button>'
    : '<button class="btn danger" type="button" id="' + id + '">' + label + '</button>';
}
function bindConfirm(id, act) {
  var a = document.getElementById(id), y = document.getElementById(id + "2"), n = document.getElementById(id + "0");
  if (a) a.addEventListener("click", function () { confirmDel = true; renderPanel(); });
  if (n) n.addEventListener("click", function () { confirmDel = false; renderPanel(); });
  if (y) y.addEventListener("click", function () { confirmDel = false; act(); });
}
function afterMarks(msg) {
  status = saveMarks() ? msg : "Браузер не дал сохранить. Возможно, включён приватный режим.";
  refreshStyles(); drawPins(); renderPanel(); renderSlots();
}

function renderPinPanel() {
  var slot = slotOf(sel.slot), p = isNewPin ? draft : pinOf(sel);
  if (!slot || !p) { sel = null; renderPanel(); return; }
  var where = '<span id="pin-where" class="crumbs"></span>';
  if (!editing) {
    panel.innerHTML = '<div class="pmeta"><span>Метка</span><span>' + esc(slot.name) + '</span>' + where + '</div>' +
      '<h2 class="pinh">' + pinHtml(p) + esc(p.title || "Без названия") + '</h2>' + tagChips(slot, p.tags) + tripLine(sel, p.ll) +
      (p.text ? '<div class="pdet">' + md(p.text) + '</div>' : '<p class="hint">Текста нет.</p>') +
      '<div class="actions"><button class="btn primary" type="button" id="p-edit">Изменить</button>' +
      '<button class="btn" type="button" id="p-show">Показать на карте</button>' + refBtn(sel) + confirmBtn("p-del", "Удалить метку") +
      (status ? '<span class="status">' + esc(status) + '</span>' : "") + '</div>' +
      "";
    fillWhere(p); bindRef(sel);
    var pe = document.getElementById("p-edit");
    if (pe) pe.addEventListener("click", function () { editing = true; draft = JSON.parse(JSON.stringify(p)); status = ""; drawPins(); renderPanel(); });
    document.getElementById("p-show").addEventListener("click", function () { openAt(p.ll); });
    bindConfirm("p-del", function () {
      slot.pins = slot.pins.filter(function (q) { return q.id !== p.id; });
      sel = null; afterMarks(""); syncHash();
    });
    return;
  }
  var st = {tags: draft.tags.slice(), colors: {}};
  panel.innerHTML = '<div class="pmeta"><span>' + (isNewPin ? "Новая метка" : "Метка") + '</span>' + where + '</div>' +
    '<h2 class="pinh" id="f-head">' + pinHtml(draft) + esc(draft.title || "Без названия") + '</h2>' +
    '<form class="form" id="f">' +
    '<div class="row"><label for="f-title">Название</label><input id="f-title" maxlength="120" placeholder="например, Убежище котерии" value="' + esc(draft.title) + '"></div>' +
    '<div class="row"><label>Значок</label><div class="icgrid">' + Object.keys(PIN).map(function (k) {
      return '<button type="button" class="icb" data-ic="' + k + '" aria-pressed="' + (k === draft.icon) + '" title="' + esc(PIN_NAME[k]) + '">' + pinSvg(k) + '</button>'; }).join("") + '</div></div>' +
    '<div class="row"><label for="f-color">Цвет</label><div class="colrow"><input type="color" id="f-color" value="' + draft.color + '">' +
      PALETTE.map(function (c) { return '<button type="button" class="sw" data-c="' + c + '" style="background:' + c + '" aria-label="Цвет ' + c + '"></button>'; }).join("") + '</div></div>' +
    '<div class="row"><label for="f-tagin">Теги</label>' + tagEdHtml(slot) + '</div>' +
    '<div class="row"><label for="f-text">Текст</label><textarea id="f-text" rows="7" placeholder="Кто здесь, что случилось, зацепки">' + esc(draft.text) + '</textarea>' + MD_HINT + '</div>' +
    (marks.slots.length > 1 ? '<div class="row"><label for="f-slot">Слот</label><select id="f-slot">' + slotOptions(slot.id) + '</select></div>' : '') +
    '<p class="hint">Метку можно перетащить по карте мышью или пальцем.</p>' +
    '<div class="actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" id="f-cancel">Отмена</button>' +
    (isNewPin ? "" : confirmBtn("f-del", "Удалить метку")) + '<span class="status">' + esc(status) + '</span></div></form>';
  fillWhere(draft);
  function head() { var h = document.getElementById("f-head"); h.innerHTML = pinHtml(draft) + esc(draft.title || "Без названия"); drawPins(); }
  var ed = bindTagEd(slot, st, function () { draft.tags = st.tags.slice(); });
  document.getElementById("f-title").addEventListener("input", function (e) { draft.title = e.target.value; head(); });
  panel.querySelector(".icgrid").addEventListener("click", function (e) {
    var b = e.target.closest("[data-ic]"); if (!b) return;
    draft.icon = b.getAttribute("data-ic");
    panel.querySelectorAll(".icb").forEach(function (x) { x.setAttribute("aria-pressed", x === b); }); head();
  });
  var ci = document.getElementById("f-color");
  ci.addEventListener("input", function () { draft.color = ci.value; head(); });
  panel.querySelector(".colrow").addEventListener("click", function (e) { var b = e.target.closest("[data-c]"); if (b) { draft.color = ci.value = b.getAttribute("data-c"); head(); } });
  document.getElementById("f-text").addEventListener("input", function (e) { draft.text = e.target.value; });
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault(); ed.flush();
    var fs = document.getElementById("f-slot"), to = slotOf(fs ? fs.value : slot.id) || slot;
    var p2 = {id: draft.id, ll: draft.ll, icon: draft.icon, color: draft.color, title: draft.title.trim().slice(0, 120), tags: st.tags.slice(),
      text: draft.text.replace(/\r/g, "").trim()};
    st.tags.forEach(function (t) { to.tags[t] = ed.color(t); });
    var i = slot.pins.map(function (q) { return q.id; }).indexOf(p2.id);
    if (to === slot && i >= 0) slot.pins[i] = p2;
    else { slot.pins = slot.pins.filter(function (q) { return q.id !== p2.id; }); to.pins.push(p2); }
    sel = {k: "pin", slot: to.id, id: p2.id}; editing = false; draft = null; isNewPin = false;
    afterMarks("Сохранено в этом браузере");
  });
  document.getElementById("f-cancel").addEventListener("click", function () {
    var was = isNewPin; editing = false; draft = null; isNewPin = false; status = "";
    if (was) { sel = null; syncHash(); }
    drawPins(); renderPanel();
  });
  bindConfirm("f-del", function () {
    slot.pins = slot.pins.filter(function (q) { return q.id !== draft.id; });
    sel = null; editing = false; draft = null; afterMarks(""); syncHash();
  });
}

// Заметка к региону в выбранном слоте: свой цвет заливки (или «не менять»), теги, текст
function renderNoteForm(s, name, meta) {
  var slot = slotOf(noteSlot) || activeSlot(), k = skey(s);
  if (!slot) { slot = newSlot("Мои метки"); marks.active = noteSlot = slot.id; saveMarks(); renderSlots(); }
  var r = slot.regions[k] || {color: "", tags: [], text: ""}, st = {tags: r.tags.slice(), colors: {}};
  panel.innerHTML = '<div class="pmeta">' + meta + '</div><h2>' + esc(name) + '</h2>' +
    '<p class="psum">Заметка хранится в этом браузере, в слоте «' + esc(slot.name) + '».</p>' +
    '<form class="form" id="f">' +
    (marks.slots.length > 1 ? '<div class="row"><label for="f-slot">Слот</label><select id="f-slot">' + slotOptions(slot.id) + '</select></div>' : '') +
    '<div class="row"><label>Цвет региона</label><div class="colrow"><label class="rad"><input type="radio" name="f-rc" value=""' + (r.color ? "" : " checked") + '> не менять</label>' +
      '<label class="rad"><input type="radio" name="f-rc" value="c"' + (r.color ? " checked" : "") + '> свой</label><input type="color" id="f-color" value="' + (r.color || PALETTE[0]) + '">' +
      PALETTE.map(function (c) { return '<button type="button" class="sw" data-c="' + c + '" style="background:' + c + '" aria-label="Цвет ' + c + '"></button>'; }).join("") + '</div></div>' +
    '<div class="row"><label for="f-tagin">Теги</label>' + tagEdHtml(slot) + '</div>' +
    '<div class="row"><label for="f-text">Текст</label><textarea id="f-text" rows="7" placeholder="Сюжетные зацепки, NPC, что угодно своё">' + esc(r.text) + '</textarea>' + MD_HINT + '</div>' +
    '<div class="actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" id="f-cancel">Отмена</button>' +
    (slot.regions[k] ? confirmBtn("f-del", "Удалить заметку") : "") + '<span class="status">' + esc(status) + '</span></div></form>';
  var ed = bindTagEd(slot, st, function () {}), ci = document.getElementById("f-color");
  function custom() { panel.querySelector('input[name="f-rc"][value="c"]').checked = true; }
  ci.addEventListener("input", custom);
  panel.querySelector(".colrow").addEventListener("click", function (e) { var b = e.target.closest("[data-c]"); if (b) { ci.value = b.getAttribute("data-c"); custom(); } });
  var fs = document.getElementById("f-slot");
  if (fs) fs.addEventListener("change", function () { noteSlot = fs.value; confirmDel = false; renderPanel(); });
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault(); ed.flush();
    var next = {color: panel.querySelector('input[name="f-rc"]:checked').value ? ci.value : "", tags: st.tags.slice(),
      text: document.getElementById("f-text").value.replace(/\r/g, "").trim()};
    st.tags.forEach(function (t) { slot.tags[t] = ed.color(t); });
    if (!next.color && !next.tags.length && !next.text) delete slot.regions[k]; else slot.regions[k] = next;
    editing = false; afterMarks("Сохранено в этом браузере");
  });
  document.getElementById("f-cancel").addEventListener("click", function () { editing = false; status = ""; renderPanel(); });
  bindConfirm("f-del", function () { delete slot.regions[k]; editing = false; afterMarks("Заметка удалена"); });
}

// ---------- меню «Метки»: слоты ----------
// Список слотов: глаз — показать или скрыть, имя — писать новые метки сюда, карандаш — окно слота (название, файл, удаление)
var slotUi = {open: false, edit: "", confirm: "", pending: null, msg: ""};
var EYE_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>';
var EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/></svg>';
var PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/></svg>';

function renderSlots() {
  var pop = document.getElementById("slots-pop"), btn = document.getElementById("slots-btn");
  if (!pop) return;
  btn.setAttribute("aria-expanded", slotUi.open ? "true" : "false");
  pop.hidden = !slotUi.open;
  if (!slotUi.open) return;
  var r = btn.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 16);
  pop.style.right = Math.min(0, Math.round(r.right - w - 8)) + "px"; // у левого края экрана окно сдвигается вправо
  var s = slotUi.edit && slotOf(slotUi.edit);
  if (s) {
    var n = s.pins.length + Object.keys(s.regions).length;
    pop.innerHTML = '<div class="sp-head"><b>Слот</b><button type="button" class="ib" data-done title="Готово">×</button></div>' +
      '<label class="sp-name">Название<input id="se-name" maxlength="60" value="' + esc(s.name) + '"></label>' +
      '<p class="lg-tip">' + esc(counts(s)) + '</p>' +
      (slotUi.pending ? '<p class="sp-warn">Заменить всё содержимое слота «' + esc(s.name) + '» метками из файла' + (slotUi.pending.name ? " «" + esc(slotUi.pending.name) + "»" : "") +
        ' (' + esc(counts(slotUi.pending.body)) + ')?</p><div class="sp-act"><button class="btn small danger" type="button" data-imp-yes>Да, заменить</button><button class="btn small" type="button" data-imp-no>Не заменять</button></div>'
      : '<div class="sp-act"><button class="btn small" type="button" data-exp' + (n ? "" : " disabled") + '>Сохранить в файл</button>' +
        '<label class="btn small" for="se-imp">Загрузить из файла</label><input type="file" id="se-imp" accept="application/json,.json" hidden>' +
        (slotUi.confirm === s.id ? '<button class="btn small danger" type="button" data-del-yes>Да, удалить слот</button><button class="btn small" type="button" data-del-no>Не удалять</button>'
          : '<button class="btn small danger" type="button" data-del>Удалить слот</button>') + '</div>') +
      '<p class="lg-tip">Загрузка заменяет всё, что было в слоте: так обновляют метки мастера или другого игрока, не трогая свои.</p>' +
      (slotUi.msg ? '<p class="sp-msg">' + esc(slotUi.msg) + '</p>' : "") +
      '<div class="sp-act"><button class="btn small primary" type="button" data-done>Готово</button></div>';
    return;
  }
  pop.innerHTML = '<div class="sp-head"><b>Слоты меток</b></div><ul class="sp-list">' + allSlots().map(function (x) {
    var act = x.id === marks.active;
    return '<li class="' + (act ? "act" : "") + (x.on ? "" : " off") + '">' +
      '<button type="button" class="ib" data-eye="' + esc(x.id) + '" title="' + (x.on ? "Скрыть слот на карте" : "Показать слот на карте") + '" aria-pressed="' + x.on + '">' + (x.on ? EYE_ON : EYE_OFF) + '</button>' +
      '<button type="button" class="sn" data-act="' + esc(x.id) + '">' + esc(x.name) +
        '<small>' + esc(counts(x)) + (act ? " · сюда пишутся новые" : "") + '</small></button>' +
      '<button type="button" class="ib" data-edit="' + esc(x.id) + '" title="Изменить слот">' + PENCIL + '</button></li>';
  }).join("") + '</ul><button type="button" class="btn small" data-add>+ Добавить новый</button>' +
    '<p class="lg-tip">Глаз — показать или скрыть слот. Нажми на имя, чтобы новые метки писались в этот слот. Карандаш — название, файл, удаление.</p>';
}
function setSlotsOpen(on) { slotUi.open = on; slotUi.edit = ""; slotUi.confirm = ""; slotUi.pending = null; slotUi.msg = ""; renderSlots(); }
function slotsChanged() { saveMarks(); refreshStyles(); drawPins(); renderPanel(); renderSlots(); }
function exportSlot(s) {
  var body = {format: FILE_FORMAT, version: 2, name: s.name, exported: new Date().toISOString(), tags: s.tags, pins: s.pins, regions: s.regions};
  var blob = new Blob([JSON.stringify(body, null, 1)], {type: "application/json"});
  var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = (s.name.replace(/[^\wа-яё -]/gi, "").trim().replace(/\s+/g, "-") || "metki") + "-dallas-2005.json";
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function applyImport(s, got) {
  s.tags = got.body.tags; s.pins = got.body.pins; s.regions = got.body.regions;
  if (got.name && (/^Новый слот/.test(s.name) || !s.name)) s.name = got.name;
  if (sel && sel.k === "pin" && sel.slot === s.id) { sel = null; editing = false; draft = null; syncHash(); }
  slotUi.pending = null; slotUi.msg = "Загружено: " + counts(s) + ".";
  slotsChanged();
}
function setupSlots() {
  var btn = document.getElementById("slots-btn"), pop = document.getElementById("slots-pop");
  btn.addEventListener("click", function (e) { e.stopPropagation(); setSlotsOpen(!slotUi.open); });
  pop.addEventListener("click", function (e) {
    e.stopPropagation();
    var b = e.target.closest("button,[data-eye]"); if (!b || b.disabled) return;
    var s = slotUi.edit && slotOf(slotUi.edit), id;
    if ((id = b.getAttribute("data-eye"))) {
      var x = slotOf(id); x.on = !x.on;
      if (!x.on && sel && sel.k === "pin" && sel.slot === id) { sel = null; editing = false; draft = null; syncHash(); }
      slotsChanged();
    } else if ((id = b.getAttribute("data-act"))) { marks.active = id; noteSlot = ""; slotsChanged(); }
    else if ((id = b.getAttribute("data-edit"))) { slotUi.edit = id; slotUi.msg = ""; renderSlots(); }
    else if (b.hasAttribute("data-add")) {
      var n = newSlot("Новый слот " + (marks.slots.length));
      if (!activeSlot() || marks.slots.length === 1) marks.active = n.id;
      saveMarks(); slotUi.edit = n.id; slotUi.msg = ""; renderSlots();
      var inp = document.getElementById("se-name"); if (inp) { inp.focus(); inp.select(); }
    }
    else if (b.hasAttribute("data-done")) { slotUi.edit = ""; slotUi.confirm = ""; slotUi.pending = null; slotUi.msg = ""; renderSlots(); }
    else if (s && b.hasAttribute("data-exp")) { exportSlot(s); slotUi.msg = "Файл скачан. Его можно отправить другому игроку или мастеру."; renderSlots(); }
    else if (s && b.hasAttribute("data-del")) { slotUi.confirm = s.id; renderSlots(); }
    else if (b.hasAttribute("data-del-no")) { slotUi.confirm = ""; renderSlots(); }
    else if (s && b.hasAttribute("data-del-yes")) {
      marks.slots = marks.slots.filter(function (x) { return x !== s; });
      if (marks.active === s.id) marks.active = marks.slots.length ? marks.slots[0].id : "";
      if (sel && sel.k === "pin" && sel.slot === s.id) { sel = null; editing = false; draft = null; syncHash(); }
      slotUi.edit = ""; slotUi.confirm = ""; slotsChanged();
    }
    else if (s && b.hasAttribute("data-imp-yes")) applyImport(s, slotUi.pending);
    else if (b.hasAttribute("data-imp-no")) { slotUi.pending = null; renderSlots(); }
  });
  pop.addEventListener("input", function (e) {
    var s = slotOf(slotUi.edit);
    if (s && e.target.id === "se-name") { s.name = e.target.value.slice(0, 60) || "Без названия"; saveMarks(); drawPins(); renderPanel(); }
  });
  pop.addEventListener("change", function (e) {
    var s = slotOf(slotUi.edit), f = e.target.files && e.target.files[0];
    if (!s || e.target.id !== "se-imp" || !f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var got = null;
      try { got = slotFromFile(JSON.parse(rd.result)); } catch (_) { slotUi.msg = "Этот файл не похож на файл меток с этой карты."; renderSlots(); return; }
      if (s.pins.length || Object.keys(s.regions).length) { slotUi.pending = got; slotUi.msg = ""; renderSlots(); }
      else applyImport(s, got);
    };
    rd.readAsText(f);
  });
  document.addEventListener("click", function (e) { if (slotUi.open && !e.target.closest("#slots-pop")) setSlotsOpen(false); });
  window.addEventListener("resize", function () { if (slotUi.open) renderSlots(); });
  renderSlots();
}

// ---------- ссылки ----------
// #n/<узел> (с «+» на конце — раскрытым), #nat/<озеро>; ссылки прежних карт (#d/<район>, #city-D5) — по таблице aliases
function syncCollapse() { document.getElementById("collapse").disabled = view.leaves || (!open.length && !sel); }
function syncHash() {
  syncCollapse();
  var h = sel && sel.k !== "pin" ? "#" + sel.k + "/" + sel.id + (sel.k === "n" && open.indexOf(sel.id) >= 0 ? "+" : "") : "";
  try { history.replaceState(null, "", h || location.pathname); } catch (_) {}
}
function readHash(fly) {
  var h = decodeURIComponent(location.hash || ""), m = /^#(n|nat)\/([^+]+)(\+?)$/.exec(h);
  if (m) {
    if (m[1] === "n" && m[3] && idx[m[2]] && !view.leaves) expand(m[2], fly);
    else select({k: m[1], id: m[2]}, fly);
    return;
  }
  m = /^#([azds])\/(.+)$/.exec(h) || /^#(city|core|fw)-([A-I][1-9])$/.exec(h);
  if (m && aliases[m[1] + ":" + m[2]]) select({k: "n", id: aliases[m[1] + ":" + m[2]]}, fly);
}

// ---------- запуск ----------
var files = ["water", "green", "nature"];
Promise.all(files.map(function (n) { return fetch(GEO + n + ".geojson").then(function (r) { if (!r.ok) throw new Error(n); return r.json(); }); })
  .concat([fetch(TREE + "index.json").then(function (r) { return r.json(); }),
    fetch(TREE + "aliases.json").then(function (r) { return r.json(); }),
    fetch("data/map.json", {cache: "no-cache"}).then(function (r) { return r.json(); }),
    fetch(TREE + "_root.geojson").then(function (r) { return r.json(); }),
    fetch("data/census.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })]))
.then(function (res) {
  files.forEach(function (n, i) { geo[n] = res[i]; });
  res[files.length].forEach(function (x) { idx[x.id] = x; (kidsOf[x.parent] = kidsOf[x.parent] || []).push(x.id); });
  aliases = res[files.length + 1];
  text = res[files.length + 2]; text.nodes = text.nodes || {}; text.nature = text.nature || {};
  document.getElementById("loading").remove();
  loadMine(); buildMap();
  loaded[""] = res[files.length + 3];
  if (res[files.length + 4]) census = res[files.length + 4];
  regLayer[""] = L.geoJSON(loaded[""], {pane: "reg", style: function (f) { return {className: regClass(f.properties.id, f.properties)}; }, onEachFeature: function (f, l) { hook(f, l); }});
  L.geoJSON({type: "FeatureCollection", features: loaded[""].features.filter(function (f) { return f.properties.id === "dallas" || f.properties.id === "fortworth"; })},
    {pane: "city", interactive: false, style: {className: "cityline"}}).addTo(map);
  syncLayers(); refresh(); setupSearch(); setupSlots(); setupRef(); drawPins(); renderPanel();
  var lt = document.getElementById("leaf-tog");
  function setLeaves(on) {
    view.leaves = on; lt.checked = on; store(VIEW_KEY, JSON.stringify(view));
    (on ? ensureAll() : Promise.resolve()).then(function () {
      syncLayers(); placeLabels(); renderPanel(); syncHash();
      if (!on && sel && sel.k === "n") select(sel, false); // раскрыть ветку до выбранного листа
    });
  }
  lt.addEventListener("change", function () { setLeaves(lt.checked); });
  if (view.leaves) setLeaves(true);
  document.getElementById("lens").addEventListener("change", function (e) { setLens(e.target.value); });
  if (view.lens) setLens(view.lens);
  document.getElementById("dart-tog").addEventListener("change", function (e) { setDart(e.target.checked); });
  if (view.dart) setDart(true);
  document.getElementById("collapse").addEventListener("click", function () { collapseTo(null); clearSel(); }); // и выбор снимаем, чтобы ссылка не тянула к региону
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && placing) { placeStop(); return; }
    if (e.key === "Escape" && slotUi.open) { setSlotsOpen(false); return; }
    if (e.key !== "Escape" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !open.length || view.leaves) return;
    var last = open[open.length - 1]; collapseTo(last); select({k: "n", id: last}, false);
  });
  readHash(true);
  window.addEventListener("hashchange", function () { readHash(true); });
}).catch(function (e) {
  if (window.console) console.error(e);
  var ld = document.getElementById("loading");
  if (ld) ld.textContent = "Не удалось загрузить данные карты. Если ты открыл файл прямо с диска, запусти локальный сервер (см. README).";
});
})();
