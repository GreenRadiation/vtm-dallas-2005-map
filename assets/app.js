/*
 * Карта Далласа и Форт-Уэрта 2005 для «Вампиры: Маскарад» (V20).
 * Регионы — дерево (data/tree.tsv → data/geo/tree/*.geojson, собирает tools/build.py, см. docs/TREE.md).
 * Сначала видны только верхние узлы. Двойной клик или «Подробнее» раскрывает регион на его детей; раскрыта всегда
 * одна ветка. Карта сама двигается только по поиску, «Показать на карте» и ссылке. Переключатель «Все районы»
 * показывает сразу все листья дерева (для проверки нарезки). Озёра и парки — отдельный слой поверх, кликается всегда.
 * Тексты и метки — data/map.json. Личные пометки игрока — только в его браузере (localStorage).
 * Два режима: «Районы» (кликаются регионы, дороги бледные) и «Дороги» (кликаются дороги, регионы бледные).
 * Подробности устройства: docs/MAP.md
 */
(function () {
"use strict";

var GEO = "data/geo/", TREE = GEO + "tree/";
var STORE_KEY = "vtm-dallas-2005-map.personal.v1";
var VIEW_KEY = "vtm-dallas-2005-map.view";
var BOUNDS = [[32.58, -97.55], [33.08, -96.50]];
var ORIGIN = [32.8005, -96.8277]; // отель Anatole, от него считаются расстояния
var MARKS = [["", "Без метки"], ["haven", "Убежище"], ["ally", "Союзники"], ["hostile", "Враждебность"], ["important", "Важное место"]];
var MLABEL = {haven: "Убежище", ally: "Союзники", hostile: "Враждебность", important: "Важное место"};
var NATKIND = {water: "Озеро", green: "Природная зона"};
// Сетки старой карты: чтобы показать клетки поверх
var GRIDS = {
  city: {cols: 9, rows: 9, n: 33.02, s: 32.62, w: -96.99, e: -96.55, label: "Даллас"},
  core: {cols: 8, rows: 8, n: 32.842222, s: 32.753333, w: -96.843333, e: -96.745556, label: "центр Далласа"},
  fw: {cols: 9, rows: 9, n: 33.00, s: 32.60, w: -97.55, e: -97.11, label: "Форт-Уэрт"}
};
var LET = "ABCDEFGHI";

var geo = {}, text = {nodes: {}, nature: {}}, mine = {items: {}}, aliases = {};
var idx = {}, kidsOf = {}; // узел по id; дети по id родителя ("" — верхний уровень)
var loaded = {}, regLayer = {}; // загруженные файлы детей и их слои: по id родителя
var open = []; // раскрытая ветка: путь от верхнего уровня
var view = {leaves: false}; // leaves — режим проверки: все листья дерева сразу, без раскрытия
var sel = null; // {k: "n" | "nat", id}
var editing = false, status = "", toolStatus = "", confirmWipe = false, moreOpen = {};
var map, featOf = {n: {}, nat: {}}, layerOf = {n: {}, nat: {}}, labelLayer, natLayer;
var selLayer = null, gridLayer, gridLabels, extra = {};
var panel = document.getElementById("panel"), toolsEl = document.getElementById("tools");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]; }); }
function paras(t) {
  return String(t || "").split(/\n\s*\n/).filter(function (p) { return p.trim(); }).map(function (p) { return "<p>" + esc(p.trim()) + "</p>"; }).join("");
}
function skey(s) { return s.k + ":" + s.id; }
function info(s) { return (s.k === "nat" ? text.nature[s.id] : text.nodes[s.id]) || {}; }
function own(s) { return mine.items[skey(s)] || null; }
function marker(s) { var o = own(s); return (o && o.marker) || info(s).marker || ""; }
function store(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }
function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function isOpen(id) { return view.leaves ? !!(idx[id] && idx[id].n) : open.indexOf(id) >= 0; }
function ancestors(id) { var out = [], p = idx[id] && idx[id].parent; while (p) { out.unshift(p); p = idx[p].parent; } return out; }
function nameOf(s) {
  if (s.k === "n") return idx[s.id].name;
  var f = featOf[s.k][s.id]; return f ? f.properties.name : "";
}

// ---------- личное хранилище ----------
// Ключи: «n:<узел>», «nat:<озеро или парк>». Пометки старых карт («d:<район>» и т. п.) переносятся по таблице aliases.
function loadMine() {
  try { var raw = load(STORE_KEY); if (raw) { var p = JSON.parse(raw); if (p && p.items) mine = p; } } catch (_) {}
  try { var v = JSON.parse(load(VIEW_KEY) || "{}"); view.leaves = !!v.leaves; } catch (_) {}
  var moved = 0;
  Object.keys(mine.items).forEach(function (k) {
    if (/^(n|nat):/.test(k)) return;
    var to = aliases[k];
    if (to && !mine.items["n:" + to]) { mine.items["n:" + to] = mine.items[k]; moved++; }
    if (to) delete mine.items[k];
  });
  if (moved) saveMine();
}
function saveMine() {
  try { mine.updated = new Date().toISOString(); localStorage.setItem(STORE_KEY, JSON.stringify(mine)); return true; }
  catch (_) { return false; }
}

// ---------- мелочи ----------
function gridCell(b, lat, lon) {
  var G = GRIDS[b], c = Math.floor((lon - G.w) / ((G.e - G.w) / G.cols)), r = Math.floor((G.n - lat) / ((G.n - G.s) / G.rows));
  return (c >= 0 && c < G.cols && r >= 0 && r < G.rows) ? LET[c] + (r + 1) : null;
}
function dist(ll) {
  var dx = (ll[1] - ORIGIN[1]) * 93.3, dy = (ll[0] - ORIGIN[0]) * 111, km = Math.sqrt(dx * dx + dy * dy);
  if (km < 0.8) return "рядом с отелем Anatole";
  return "≈ " + (km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)) + " км от отеля Anatole";
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

// ---------- карта ----------
function buildMap() {
  map = L.map("map", {zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, minZoom: 9, maxZoom: 16, maxBounds: L.latLngBounds(BOUNDS).pad(0.15),
    maxBoundsViscosity: 0.8, attributionControl: true, doubleClickZoom: false, renderer: L.svg({padding: 0.5})});
  map.attributionControl.setPrefix(false).addAttribution('Геоданные © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, перепись США 2000');
  [["land", 200], ["reg", 300], ["green", 320], ["water", 330], ["nat", 340], ["sel", 430], ["grid", 440], ["labels", 450]].forEach(function (p) {
    map.createPane(p[0]).style.zIndex = p[1];
  });
  ["green", "water", "grid", "labels", "sel"].forEach(function (p) { map.getPane(p).style.pointerEvents = "none"; });

  L.rectangle(BOUNDS, {pane: "land", className: "land", interactive: false}).addTo(map);
  L.geoJSON(geo.green, {pane: "green", interactive: false, style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls !== "creek"; },
    style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  extra.creek = L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls === "creek"; }, style: {className: "creek"}});

  // озёра и парки: всегда видны и кликаются
  natLayer = L.geoJSON(geo.nature, {pane: "nat", style: function (f) { return {className: "nat k-" + f.properties.kind}; },
    onEachFeature: function (f, l) {
      var id = f.properties.id; featOf.nat[id] = f; layerOf.nat[id] = l;
      l.bindTooltip(esc(f.properties.name), {sticky: true, direction: "top", className: "tip", offset: [0, -6]});
      l.on("click", function (e) { L.DomEvent.stopPropagation(e); select({k: "nat", id: id}, false); });
    }}).addTo(map);

  labelLayer = L.layerGroup().addTo(map);
  buildGrid();

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
  var x = idx[id], m = marker({k: "n", id: id}), inh = "";
  p = p || (featOf.n[id] ? featOf.n[id].properties : {});
  if (!m && x.n && !isOpen(id)) { // свёрнутый регион показывает метки того, что внутри
    descendants(id).some(function (d) { var dm = marker({k: "n", id: d}); if (dm) inh = " mi-" + dm; return dm; });
  }
  var parent = x.parent || "", focus = view.leaves || parent === (open.length ? open[open.length - 1] : "");
  return "reg d" + Math.min(x.depth, 3) + " t" + (p.tone || 0) + " s" + (p.shade || 0) +
    " k-" + (x.kind || "area") + (isOpen(id) ? " exp" : focus ? " focus" : " ctx") + (m ? " m-" + m : inh);
}
function descendants(id) {
  var out = [];
  (kidsOf[id] || []).forEach(function (c) { out.push(c); out = out.concat(descendants(c)); });
  return out;
}

function hook(f, l) {
  var id = f.properties.id;
  featOf.n[id] = f; layerOf.n[id] = l;
  l.bindTooltip(function () { return esc(idx[id].name) + (idx[id].n && !isOpen(id) ? '<small>двойной клик — что внутри</small>' : ''); },
    {sticky: true, direction: "top", className: "tip", offset: [0, -6]});
  l.on("click", function (e) { L.DomEvent.stopPropagation(e); select({k: "n", id: id}, false); });
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
  document.getElementById("collapse").disabled = view.leaves || !open.length;
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
  sel = null; if (selLayer) map.removeLayer(selLayer); selLayer = null;
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
  sel = s; editing = false; status = "";
  drawSel();
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
  if (!sel) return;
  var cls = "selpath" + (sel.k === "n" && isOpen(sel.id) ? " selopen" : "");
  selLayer = L.geoJSON(featOf[sel.k][sel.id], {pane: "sel", interactive: false, style: {className: cls}}).addTo(map);
  map.getContainer().classList.add("has-sel");
}

function refreshStyles() {
  Object.keys(layerOf.n).forEach(function (id) { var el = layerOf.n[id].getElement(); if (el) el.setAttribute("class", regClass(id) + " leaflet-interactive"); });
  Object.keys(layerOf.nat).forEach(function (id) {
    var el = layerOf.nat[id].getElement(), m = marker({k: "nat", id: id});
    if (el) el.setAttribute("class", "nat k-" + featOf.nat[id].properties.kind + (m ? " m-" + m : "") + " leaflet-interactive");
  });
}

// ---------- карточка региона ----------
var INTRO = '<div class="pmeta"><span>Даллас, Форт-Уэрт и пригороды · весна 2005</span></div><h2>Карта районов</h2>' +
  '<div class="pdet"><p>Сначала на карте только города и пригороды. Нажми на регион, и здесь откроется его описание.</p>' +
  '<p>Чтобы заглянуть внутрь, дважды щёлкни по региону или нажми «Подробнее» в карточке: он разделится на части, а те — на районы. Раскрыта всегда одна ветка; «Свернуть всё» в шапке возвращает общий вид.</p>' +
  '<p>Озёра, парки и заповедники видны всегда, их тоже можно открыть.</p>' +
  '<p>К любому региону можно добавить свою метку и заметки: они хранятся только в твоём браузере.</p></div>';

function crumbs(id) {
  return ancestors(id).map(function (a) { return '<a href="#n/' + esc(a) + '" data-crumb="' + esc(a) + '">' + esc(idx[a].name) + '</a>'; });
}

function renderPanel() {
  if (!sel) { panel.innerHTML = INTRO; return; }
  var s = sel, x = info(s), o = own(s) || {marker: "", label: "", notes: ""};
  var node = s.k === "n" ? idx[s.id] : null, np = s.k === "nat" ? featOf.nat[s.id].properties : null;
  var name = node ? node.name : np.name, km2 = node ? node.km2 : np.km2, ll = node ? [node.ly, node.lx] : [np.ly, np.lx];
  var meta = '<span>' + (node ? kindLabel(s.id) : NATKIND[np.kind]) + '</span>' + (node ? crumbs(s.id).join('<span>›</span>') : '');

  if (editing) {
    var mopts = MARKS.map(function (m) { return '<option value="' + m[0] + '"' + (m[0] === (o.marker || "") ? " selected" : "") + '>' + m[1] + '</option>'; }).join("");
    panel.innerHTML = '<div class="pmeta">' + meta + '</div><h2>' + esc(name) + '</h2>' +
      '<p class="psum">Эти пометки видишь только ты. Они хранятся в этом браузере.</p>' +
      '<form class="form" id="f"><div class="two"><div class="row"><label for="f-m">Моя метка</label><select id="f-m">' + mopts + '</select></div>' +
      '<div class="row"><label for="f-tag">Подпись</label><input id="f-tag" placeholder="например, Логово шерифа" value="' + esc(o.label) + '"></div></div>' +
      '<div class="row"><label for="f-notes">Мои заметки</label><textarea id="f-notes" rows="7" placeholder="Сюжетные зацепки, NPC, что угодно своё">' + esc(o.notes) + '</textarea></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" id="f-cancel">Отмена</button>' +
      (own(s) ? '<button class="btn danger" type="button" id="f-del">Удалить мои пометки</button>' : '') +
      '<span class="status">' + esc(status) + '</span></div></form>';
    document.getElementById("f").addEventListener("submit", function (e) {
      e.preventDefault();
      var next = {marker: document.getElementById("f-m").value, label: document.getElementById("f-tag").value.trim(),
        notes: document.getElementById("f-notes").value.replace(/\r/g, "").trim()};
      if (!next.marker && !next.label && !next.notes) delete mine.items[skey(s)]; else mine.items[skey(s)] = next;
      if (saveMine()) { editing = false; status = "Сохранено в этом браузере"; }
      else status = "Браузер не дал сохранить. Возможно, включён приватный режим.";
      refreshStyles(); renderPanel(); renderTools();
    });
    document.getElementById("f-cancel").addEventListener("click", function () { editing = false; status = ""; renderPanel(); });
    var del = document.getElementById("f-del");
    if (del) del.addEventListener("click", function () { delete mine.items[skey(s)]; saveMine(); editing = false; status = "Мои пометки удалены"; refreshStyles(); renderPanel(); renderTools(); });
    return;
  }

  var chips = "";
  if (x.marker && MLABEL[x.marker]) chips += '<span class="chip m-' + x.marker + '">' + esc(MLABEL[x.marker]) + '</span>';
  if (x.label) chips += '<span class="chip">' + esc(x.label) + '</span>';
  var mineBlock = own(s) ? '<div class="mine"><h3>Мои пометки</h3>' +
    ((o.marker || o.label) ? '<div class="pmeta" style="margin-bottom:6px">' + (o.marker ? '<span class="chip m-' + o.marker + '">' + esc(MLABEL[o.marker]) + '</span>' : '') + (o.label ? '<span class="chip">' + esc(o.label) + '</span>' : '') + '</div>' : '') +
    (o.notes ? '<p>' + esc(o.notes) + '</p>' : '') + '</div>' : "";
  // своего текста нет — показываем описание ближайшего предка, у которого он есть
  var body = (x.details || "").trim() ? '<div class="pdet">' + paras(x.details) + '</div>' : "";
  if (!body && node) {
    var up = ancestors(s.id).reverse().filter(function (a) { return ((text.nodes[a] || {}).details || "").trim(); })[0];
    body = up ? '<div class="inherit"><h3>' + esc(kindLabel(up)) + ' «' + esc(idx[up].name) + '»</h3>' + paras(text.nodes[up].details) + '</div>'
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
    (chips ? '<div class="pmeta" style="margin-bottom:8px">' + chips + '</div>' : '') +
    '<div class="pmeta" style="margin-bottom:12px"><span>≈ ' + String(km2).replace(".", ",") + ' км²</span><span>' + dist(ll) + '</span>' +
    (cells.length && gridOn() ? '<span>старая сетка: ' + esc(cells.join(", ")) + '</span>' : '') + '</div>' +
    (x.summary ? '<p class="psum">' + esc(x.summary) + '</p>' : "") + body +
    (x.more && x.more.trim() ? '<details class="pmore" id="p-more"' + (moreOpen[skey(s)] ? " open" : "") + '><summary>Ещё</summary><div class="pdet">' + paras(x.more) + '</div></details>' : "") +
    (x.notes && x.notes.trim() ? '<div class="notes"><h3>Заметки мастера</h3><p>' + esc(x.notes) + '</p></div>' : "") +
    mineBlock +
    '<div class="actions">' +
    (node && node.n && !view.leaves ? (opened ? '<button class="btn primary" type="button" id="p-fold">Свернуть</button>' : '<button class="btn primary" type="button" id="p-open">Подробнее</button>') : '') +
    '<button class="btn" type="button" id="p-edit">' + (own(s) ? "Изменить мои пометки" : "Добавить свою пометку") + '</button>' +
    '<button class="btn" type="button" id="p-show">Показать на карте</button>' +
    (status ? '<span class="status">' + esc(status) + '</span>' : "") + '</div>' + kids;
  var pm = document.getElementById("p-more");
  if (pm) pm.addEventListener("toggle", function () { if (pm.open) moreOpen[skey(s)] = 1; else delete moreOpen[skey(s)]; });
  var po = document.getElementById("p-open"); if (po) po.addEventListener("click", function () { expand(s.id); });
  var pf = document.getElementById("p-fold"); if (pf) pf.addEventListener("click", function () { collapseTo(s.id); });
  document.getElementById("p-edit").addEventListener("click", function () { editing = true; status = ""; renderPanel(); var t = document.getElementById("f-notes"); if (t) t.focus(); });
  document.getElementById("p-show").addEventListener("click", function () { select(s, true); });
}

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
function setupSearch() {
  var q = document.getElementById("q"), box = document.getElementById("results"), all = [];
  Object.keys(idx).forEach(function (id) {
    var a = ancestors(id);
    all.push({k: "n", id: id, name: idx[id].name, sub: kindLabel(id).toLowerCase() + (a.length ? " · " + idx[a[a.length - 1]].name : ""), lv: idx[id].depth});
  });
  geo.nature.features.forEach(function (f) { all.push({k: "nat", id: f.properties.id, name: f.properties.name, sub: NATKIND[f.properties.kind].toLowerCase(), lv: 4}); });
  function norm(s) { return s.toLowerCase().replace(/ё/g, "е").replace(/[-‐\s]+/g, " "); }
  function showRes() {
    var v = norm(q.value.trim());
    if (!v) { box.hidden = true; return; }
    var hits = all.filter(function (x) { return norm(x.name).indexOf(v) >= 0; })
      .sort(function (a, b) { return norm(a.name).indexOf(v) - norm(b.name).indexOf(v) || a.lv - b.lv || a.name.length - b.name.length; }).slice(0, 14);
    box.innerHTML = hits.length ? hits.map(function (x) { return '<button type="button" data-k="' + x.k + '" data-id="' + esc(x.id) + '">' + esc(x.name) + '<small>' + esc(x.sub) + '</small></button>'; }).join("")
      : '<button type="button" disabled>Ничего не нашлось</button>';
    box.hidden = false;
  }
  q.addEventListener("input", showRes);
  q.addEventListener("focus", showRes);
  q.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { var b = box.querySelector("button[data-id]"); if (b) b.click(); }
    if (e.key === "Escape") { box.hidden = true; q.blur(); }
  });
  box.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-id]"); if (!b) return;
    box.hidden = true; q.value = "";
    select({k: b.getAttribute("data-k"), id: b.getAttribute("data-id")}, true);
  });
  document.addEventListener("click", function (e) { if (!e.target.closest(".search")) box.hidden = true; });
}

// ---------- личные пометки: файл ----------
function renderTools() {
  var n = Object.keys(mine.items).length;
  toolsEl.innerHTML =
    '<span class="status">Мои пометки: ' + n + '</span>' +
    '<button class="btn small" type="button" id="t-exp"' + (n ? '' : ' disabled') + '>Скачать файлом</button>' +
    '<label class="btn small" for="t-imp" style="cursor:pointer">Загрузить из файла</label><input type="file" id="t-imp" accept="application/json,.json" hidden>' +
    (n ? (confirmWipe
      ? '<button class="btn small danger" type="button" id="t-wipe2">Да, удалить все</button><button class="btn small" type="button" id="t-wipe0">Не удалять</button>'
      : '<button class="btn small danger" type="button" id="t-wipe">Удалить все мои пометки</button>') : '') +
    (toolStatus ? '<span class="status">' + esc(toolStatus) + '</span>' : '');
  var exp = document.getElementById("t-exp");
  if (exp) exp.addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(mine, null, 1)], {type: "application/json"});
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "moi-pometki-dallas-2005-rajony.json"; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toolStatus = "Файл скачан. Его можно загрузить в другом браузере или на другом устройстве."; renderTools();
  });
  document.getElementById("t-imp").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try { toolStatus = importFile(JSON.parse(rd.result)); } catch (_) { toolStatus = "Этот файл не похож на файл пометок с этой карты."; }
      refreshStyles(); renderPanel(); renderTools();
    };
    rd.readAsText(f);
  });
  var w = document.getElementById("t-wipe"); if (w) w.addEventListener("click", function () { confirmWipe = true; renderTools(); });
  var w0 = document.getElementById("t-wipe0"); if (w0) w0.addEventListener("click", function () { confirmWipe = false; renderTools(); });
  var w2 = document.getElementById("t-wipe2"); if (w2) w2.addEventListener("click", function () {
    mine = {items: {}}; saveMine(); confirmWipe = false; toolStatus = "Все мои пометки удалены."; refreshStyles(); renderPanel(); renderTools();
  });
}

// Файл этой карты ({items}), прежней карты в четыре масштаба (ключи «d:<район>») или старой карты в клетку ({cells: {"city:D5": …}}).
function importFile(p) {
  var n = 0;
  function put(key, src) {
    var dst = mine.items[key] || {marker: "", label: "", notes: ""};
    dst.marker = src.marker || dst.marker || "";
    dst.label = src.label || dst.label || "";
    if (src.notes && (dst.notes || "").indexOf(src.notes) < 0) dst.notes = (dst.notes ? dst.notes + "\n\n" : "") + src.notes;
    mine.items[key] = dst; n++;
  }
  if (p && p.items && typeof p.items === "object") {
    Object.keys(p.items).forEach(function (k) {
      var g = k.split(":"), id = g.slice(1).join(":");
      if ((g[0] === "n" && idx[id]) || (g[0] === "nat" && featOf.nat[id])) put(k, p.items[k]);
      else if (aliases[k]) put("n:" + aliases[k], p.items[k]);
    });
    saveMine(); return "Загружено пометок: " + n + ". Пометки прежних версий карты легли на регион в том же месте.";
  }
  if (p && p.cells && typeof p.cells === "object") {
    Object.keys(p.cells).forEach(function (k) {
      var to = aliases[k]; if (!to) return;
      var src = p.cells[k];
      put("n:" + to, {marker: src.marker, label: src.label, notes: src.notes ? "[старая клетка " + k + "] " + src.notes : ""});
    });
    saveMine(); return "Перенесено пометок со старой карты: " + n + ". Каждая клетка легла на район в её центре.";
  }
  throw new Error("bad");
}

// ---------- ссылки ----------
// #n/<узел> (с «+» на конце — раскрытым), #nat/<озеро>; ссылки прежних карт (#d/<район>, #city-D5) — по таблице aliases
function syncHash() {
  var h = sel ? "#" + sel.k + "/" + sel.id + (sel.k === "n" && open.indexOf(sel.id) >= 0 ? "+" : "") : "";
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
    fetch(TREE + "_root.geojson").then(function (r) { return r.json(); })]))
.then(function (res) {
  files.forEach(function (n, i) { geo[n] = res[i]; });
  res[files.length].forEach(function (x) { idx[x.id] = x; (kidsOf[x.parent] = kidsOf[x.parent] || []).push(x.id); });
  aliases = res[files.length + 1];
  text = res[files.length + 2]; text.nodes = text.nodes || {}; text.nature = text.nature || {};
  document.getElementById("loading").remove();
  loadMine(); buildMap();
  loaded[""] = res[files.length + 3];
  regLayer[""] = L.geoJSON(loaded[""], {pane: "reg", style: function (f) { return {className: regClass(f.properties.id, f.properties)}; }, onEachFeature: function (f, l) { hook(f, l); }});
  syncLayers(); refresh(); setupSearch(); renderTools(); renderPanel();
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
  document.getElementById("collapse").addEventListener("click", function () { collapseTo(null); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !open.length || view.leaves) return;
    var last = open[open.length - 1]; collapseTo(last); select({k: "n", id: last}, false);
  });
  readHash(true);
  window.addEventListener("hashchange", function () { readHash(true); });
}).catch(function (e) {
  document.getElementById("loading").textContent = "Не удалось загрузить данные карты. Если ты открыл файл прямо с диска, запусти локальный сервер (см. README).";
  if (window.console) console.error(e);
});
})();
