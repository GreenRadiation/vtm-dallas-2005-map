/*
 * Карта Далласа и Форт-Уэрта 2005 для «Вампиры: Маскарад» (V20).
 * Три масштаба регионов: области (l1), районы (l2), секторы (l3) — data/geo/*.geojson, их собирает tools/build.py.
 * Тексты и метки — data/map.json. Личные пометки игрока — только в его браузере (localStorage).
 * Два режима: «Районы» (кликаются регионы, дороги бледные) и «Дороги» (кликаются дороги, регионы бледные).
 * Подробности устройства: docs/MAP.md
 */
(function () {
"use strict";

var GEO = "data/geo/";
var STORE_KEY = "vtm-dallas-2005-map.personal.v1";
var VIEW_KEY = "vtm-dallas-2005-map.view";
var BOUNDS = [[32.58, -97.55], [33.08, -96.50]];
var ORIGIN = [32.8005, -96.8277]; // отель Anatole, от него считаются расстояния
// Уровни: ключ в ссылках и пометках, файл, название кнопки, слово в карточке
var LEVELS = {
  1: {k: "a", file: "l1", btn: "Крупный", one: "Область", text: "areas"},
  2: {k: "d", file: "l2", btn: "Средний", one: "Район", text: "districts"},
  3: {k: "s", file: "l3", btn: "Мелкий", one: "Сектор", text: "sectors"}
};
var LEVEL_OF = {a: 1, d: 2, s: 3};
var AUTO = [11, 12.5]; // «Авто»: до 11 — крупный масштаб, до 12.5 — средний, дальше — мелкий
var ZOOM_FOR = {1: [9, 10.5], 2: [11, 12.25], 3: [12.5, 13.5]}; // куда приближать при выборе региона уровня
var KIND = {water: "Озеро", green: "Природная зона", airport: "Аэропорт", rural: "Сельская местность"};
var MARKS = [["", "Без метки"], ["haven", "Убежище"], ["ally", "Союзники"], ["hostile", "Враждебность"], ["important", "Важное место"]];
var MLABEL = {haven: "Убежище", ally: "Союзники", hostile: "Враждебность", important: "Важное место"};
// Сетки старой карты: чтобы показать клетки поверх и открыть старые ссылки вида #city-D5
var GRIDS = {
  city: {cols: 9, rows: 9, n: 33.02, s: 32.62, w: -96.99, e: -96.55, label: "Даллас"},
  core: {cols: 8, rows: 8, n: 32.842222, s: 32.753333, w: -96.843333, e: -96.745556, label: "центр Далласа"},
  fw: {cols: 9, rows: 9, n: 33.00, s: 32.60, w: -97.55, e: -97.11, label: "Форт-Уэрт"}
};
var LET = "ABCDEFGHI";

var geo = {}, text = {areas: {}, districts: {}, sectors: {}}, mine = {items: {}};
var view = {level: "auto", mode: "regions"};
var sel = null; // {k: "a"|"d"|"s"|"r", id}
var editing = false, status = "", toolStatus = "", confirmWipe = false, moreOpen = {};
var map, cur = 0, featOf = {a: {}, d: {}, s: {}, r: {}}, layerOf = {a: {}, d: {}, s: {}, r: {}}, labelPt = {a: {}, d: {}, s: {}};
var regLayer = {}, outline = {}, labels = {}, children = {a: {}, d: {}};
var selLayer = null, gridLayer, gridLabels, roadVis = {}, roadHit = {}, roadLine = {}, extra = {};
var panel = document.getElementById("panel"), toolsEl = document.getElementById("tools");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]; }); }
function paras(t) {
  return String(t || "").split(/\n\s*\n/).filter(function (p) { return p.trim(); }).map(function (p) { return "<p>" + esc(p.trim()) + "</p>"; }).join("");
}
function skey(s) { return s.k + ":" + s.id; }
function props(s) { var f = featOf[s.k][s.id]; return f ? f.properties : {}; }
function info(s) { var L = LEVELS[LEVEL_OF[s.k]]; return (L && text[L.text][s.id]) || {}; }
function own(s) { return mine.items[skey(s)] || null; }
function marker(s) { var o = own(s); return (o && o.marker) || info(s).marker || ""; }
function parentOf(s) {
  var p = props(s);
  if (s.k === "s") return {k: "d", id: p.parent};
  if (s.k === "d") return {k: "a", id: p.area};
  return null;
}
function store(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }
function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

// ---------- личное хранилище ----------
function loadMine() {
  try { var raw = load(STORE_KEY); if (raw) { var p = JSON.parse(raw); if (p && p.items) mine = p; } } catch (_) {}
  try { var v = JSON.parse(load(VIEW_KEY) || "{}"); if (v.level) view.level = v.level; if (v.mode) view.mode = v.mode; } catch (_) {}
}
function saveMine() {
  try { mine.updated = new Date().toISOString(); localStorage.setItem(STORE_KEY, JSON.stringify(mine)); return true; }
  catch (_) { return false; }
}

// ---------- геометрия ----------
function ringHas(r, x, y) {
  var inside = false;
  for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
    var xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyHas(g, lon, lat) {
  var polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some(function (p) { return ringHas(p[0], lon, lat) && !p.slice(1).some(function (h) { return ringHas(h, lon, lat); }); });
}
function regionAt(level, lat, lon) {
  var f = geo[LEVELS[level].file].features.filter(function (f) { return polyHas(f.geometry, lon, lat); })[0];
  return f ? f.properties.id : null;
}
function gridCell(b, lat, lon) {
  var G = GRIDS[b], c = Math.floor((lon - G.w) / ((G.e - G.w) / G.cols)), r = Math.floor((G.n - lat) / ((G.n - G.s) / G.rows));
  return (c >= 0 && c < G.cols && r >= 0 && r < G.rows) ? LET[c] + (r + 1) : null;
}
function cellCenter(b, id) {
  var G = GRIDS[b], c = LET.indexOf(id[0]), r = +id.slice(1) - 1;
  return [G.n - (r + .5) * (G.n - G.s) / G.rows, G.w + (c + .5) * (G.e - G.w) / G.cols];
}
function dist(ll) {
  var dx = (ll[1] - ORIGIN[1]) * 93.3, dy = (ll[0] - ORIGIN[0]) * 111, km = Math.sqrt(dx * dx + dy * dy);
  if (km < 0.8) return "рядом с отелем Anatole";
  return "≈ " + (km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)) + " км от отеля Anatole";
}

// ---------- карта ----------
function buildMap() {
  map = L.map("map", {zoomSnap: 0.5, zoomDelta: 0.5, minZoom: 9, maxZoom: 16, maxBounds: L.latLngBounds(BOUNDS).pad(0.15),
    maxBoundsViscosity: 0.8, attributionControl: true, renderer: L.svg({padding: 0.5})});
  map.attributionControl.setPrefix(false).addAttribution('Геоданные © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, перепись США 2000');
  [["land", 200], ["reg", 300], ["green", 320], ["water", 330], ["outline", 360], ["roads", 400], ["roadhit", 420], ["sel", 430], ["grid", 440], ["labels", 450]].forEach(function (p) {
    map.createPane(p[0]).style.zIndex = p[1];
  });
  ["green", "water", "outline", "roads", "grid", "labels"].forEach(function (p) { map.getPane(p).style.pointerEvents = "none"; });

  L.rectangle(BOUNDS, {pane: "land", className: "land", interactive: false}).addTo(map);
  L.geoJSON(geo.green, {pane: "green", interactive: false, style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls !== "creek"; },
    style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  extra.creek = L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls === "creek"; }, style: {className: "creek"}});

  [1, 2, 3].forEach(function (lv) {
    var k = LEVELS[lv].k;
    regLayer[lv] = L.geoJSON(geo[LEVELS[lv].file], {pane: "reg", style: function (f) { return {className: regClass(k, f.properties)}; },
      onEachFeature: function (f, l) { hook(k, f, l); }});
    if (lv < 3) outline[lv] = L.geoJSON(geo[LEVELS[lv].file], {pane: "outline", interactive: false, style: {className: "outl outl" + lv}});
    labels[lv] = L.layerGroup();
  });
  geo.l2.features.forEach(function (f) { (children.a[f.properties.area] = children.a[f.properties.area] || []).push(f.properties.id); });
  geo.l3.features.forEach(function (f) { (children.d[f.properties.parent] = children.d[f.properties.parent] || []).push(f.properties.id); });

  // дороги: видимая линия + невидимая широкая полоса для мышки (только в режиме «Дороги»)
  ["secondary", "primary", "motorway"].forEach(function (cls) {
    var feats = geo.roads.features.filter(function (f) { return f.properties.cls === cls; });
    roadVis[cls] = L.geoJSON(feats, {pane: "roads", interactive: false, style: {className: "rd rd-" + cls},
      onEachFeature: function (f, l) { if (f.properties.id) roadLine[f.properties.id] = l; }});
    if (cls !== "secondary") roadHit[cls] = L.geoJSON(feats.filter(function (f) { return f.properties.id; }), {pane: "roadhit", style: {className: "rdhit", weight: 14},
      onEachFeature: function (f, l) { hookRoad(f, l); }});
  });
  extra.dart = L.geoJSON(geo.rail, {pane: "roads", interactive: false, filter: function (f) { return f.properties.cls === "dart"; }, style: {className: "dart"}});
  extra.rail = L.geoJSON(geo.rail, {pane: "roads", interactive: false, filter: function (f) { return f.properties.cls === "rail"; }, style: {className: "rail"}});

  geo.labels.features.forEach(function (f) {
    var p = f.properties, k = LEVELS[p.level].k, ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
    labelPt[k][p.id] = ll;
    var m = L.marker(ll, {pane: "labels", interactive: false, keyboard: false, opacity: 0,
      icon: L.divIcon({className: "lbl lbl" + p.level + (p.kind ? " lk-" + p.kind : ""), html: "<span>" + esc(p.name) + "</span>", iconSize: null})});
    // важность подписи: крупные важнее, центры Далласа и Форт-Уэрта — важнее всего
    m.km2 = p.km2; m.lid = p.id; m.rank = p.km2 * (p.level !== 1 ? 1 : /^(dal|fw)-center$/.test(p.id) ? 100 : /^(dal|fw)-/.test(p.id) ? 5 : 1);
    labels[p.level].addLayer(m);
  });
  buildGrid();

  map.on("zoomend", refresh);
  if (map.getSize().x < 600) map.fitBounds([[32.68, -97.0], [32.95, -96.62]]); // на телефоне начинаем с Далласа
  else map.fitBounds([[32.62, -97.45], [33.02, -96.58]]);
  refresh();
  window.vtmMap = map; // для отладки из консоли
}

function regClass(k, p) {
  var m = marker({k: k, id: p.id}), inh = "";
  if (!m && k === "s") { var pm = marker({k: "d", id: p.parent}); if (pm) inh = " mi-" + pm; } // метка района видна и на его секторах
  return "reg reg" + LEVEL_OF[k] + " t" + (p.tone || 0) + " s" + (p.shade || 0) + (p.kind ? " k-" + p.kind : "") + (m ? " m-" + m : inh);
}

function hook(k, f, l) {
  featOf[k][f.properties.id] = f; layerOf[k][f.properties.id] = l;
  l.bindTooltip(esc(f.properties.name), {sticky: true, direction: "top", className: "tip", offset: [0, -6]});
  l.on("click", function (e) { L.DomEvent.stopPropagation(e); select({k: k, id: f.properties.id}, false); });
  l.on("mouseover", function () { var el = l.getElement(); if (el) el.classList.add("hov"); });
  l.on("mouseout", function () { var el = l.getElement(); if (el) el.classList.remove("hov"); });
}

function roadTitle(p) { return p.ref && p.name ? p.ref + " · " + p.name : (p.ref || p.name); }
function hookRoad(f, l) {
  var id = f.properties.id;
  featOf.r[id] = f; layerOf.r[id] = l;
  l.bindTooltip(esc(roadTitle(f.properties)), {sticky: true, direction: "top", className: "tip tip-road", offset: [0, -8]});
  l.on("click", function (e) { L.DomEvent.stopPropagation(e); select({k: "r", id: id}, false); });
  l.on("mouseover", function () { var v = roadLine[id] && roadLine[id].getElement(); if (v) v.classList.add("rd-hov"); });
  l.on("mouseout", function () { var v = roadLine[id] && roadLine[id].getElement(); if (v) v.classList.remove("rd-hov"); });
}

// Какой масштаб регионов сейчас показан
function effLevel() {
  if (view.mode === "roads") return 1; // в режиме дорог регионы — только бледный фон крупных областей
  if (view.level !== "auto") return +view.level;
  var z = map.getZoom();
  return z < AUTO[0] ? 1 : z < AUTO[1] ? 2 : 3;
}

function show(layer, on) { if (on) { if (!map.hasLayer(layer)) layer.addTo(map); } else if (map.hasLayer(layer)) map.removeLayer(layer); }

// Всё, что зависит от масштаба, режима и уровня
function refresh() {
  var z = map.getZoom(), el = map.getContainer(), roads = view.mode === "roads", lv = effLevel();
  el.className = el.className.replace(/\b(z\d+|mode-\w+|lv\d)\b/g, "").replace(/\s+/g, " ").trim() +
    " z" + Math.floor(z) + " mode-" + view.mode + " lv" + lv;
  if (lv !== cur) {
    [1, 2, 3].forEach(function (n) { show(regLayer[n], n === lv); });
    cur = lv;
  }
  show(outline[1], lv >= 2 || roads);
  show(outline[2], lv === 3 && !roads);
  [1, 2, 3].forEach(function (n) { show(labels[n], n === lv); });
  // дороги: в режиме районов только фривеи (бледно) и вблизи большие улицы; в режиме дорог — всё и кликается
  show(roadVis.motorway, true);
  show(roadVis.primary, roads ? z >= 11 : z >= 13);
  show(roadVis.secondary, roads && z >= 13);
  show(roadHit.motorway, roads);
  show(roadHit.primary, roads && z >= 11);
  show(extra.dart, roads && z >= 11);
  show(extra.rail, roads && z >= 12.5);
  show(extra.creek, z >= 13);
  if (gridLabels) show(gridLabels, gridOn() && z >= 10.5);
  placeLabels();
  updateControls();
}

// Подписи без наложения: важные (крупные) ставятся первыми, остальные — только если есть место.
function placeLabels() {
  var lv = cur, z = map.getZoom(), placed = [];
  var pxPerKm = 256 * Math.pow(2, z) / (40075 * Math.cos(32.8 * Math.PI / 180));
  var minSide = lv === 1 ? 0 : 26;
  function fits(m) {
    var el = m.getElement(); if (!el) return false;
    var sp = el.firstChild, w = sp.offsetWidth, h = sp.offsetHeight, p = map.latLngToLayerPoint(m.getLatLng());
    var b = [p.x - w / 2 - 4, p.y - h / 2 - 2, p.x + w / 2 + 4, p.y + h / 2 + 2];
    for (var i = 0; i < placed.length; i++) {
      var o = placed[i];
      if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return false;
    }
    placed.push(b); return true;
  }
  var list = []; labels[lv].eachLayer(function (m) { list.push(m); });
  var selId = sel && LEVEL_OF[sel.k] === lv ? sel.id : null;
  list.sort(function (a, b) { return (b.lid === selId) - (a.lid === selId) || b.rank - a.rank; });
  list.forEach(function (m) {
    var on = (m.lid === selId || Math.sqrt(m.km2) * pxPerKm >= minSide) && fits(m);
    if (on !== m._shown) { m._shown = on; m.setOpacity(on ? 1 : 0); }
  });
}

function updateControls() {
  var eff = effLevel();
  document.querySelectorAll("#lv button").forEach(function (b) {
    var l = b.getAttribute("data-l");
    b.setAttribute("aria-pressed", l === String(view.level) ? "true" : "false");
    b.classList.toggle("eff", view.level === "auto" && l === String(eff));
  });
  document.querySelectorAll("#md button").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-m") === view.mode ? "true" : "false"); });
  document.getElementById("lv").classList.toggle("off", view.mode === "roads");
}

function setLevel(l) {
  view.level = l; store(VIEW_KEY, JSON.stringify(view));
  if (view.mode === "roads") { view.mode = "regions"; if (sel && sel.k === "r") clearSel(); }
  if (l !== "auto") { // приблизить или отдалить, чтобы выбранный масштаб было удобно разглядывать
    var r = ZOOM_FOR[+l], z = map.getZoom();
    if (z < r[0] || z > r[1] + 1.5) map.flyTo(map.getCenter(), Math.min(Math.max(z, r[0]), r[1]), {duration: 0.4});
  }
  refresh();
}
function setMode(m) {
  view.mode = m; store(VIEW_KEY, JSON.stringify(view));
  if (sel && (sel.k === "r") !== (m === "roads")) clearSel();
  refresh();
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

function select(s, fly) {
  if (!s || !featOf[s.k][s.id]) return;
  if ((s.k === "r") !== (view.mode === "roads")) { view.mode = s.k === "r" ? "roads" : "regions"; store(VIEW_KEY, JSON.stringify(view)); }
  sel = s; editing = false; status = "";
  if (selLayer) map.removeLayer(selLayer);
  selLayer = L.geoJSON(featOf[s.k][s.id], {pane: "sel", interactive: false, style: {className: s.k === "r" ? "selroad" : "selpath"}}).addTo(map);
  map.getContainer().classList.toggle("has-sel", s.k !== "r");
  var lv = LEVEL_OF[s.k];
  // выбранный регион другого масштаба: в ручном режиме переключаем кнопку на его масштаб
  if (lv && view.level !== "auto" && +view.level !== lv) { view.level = String(lv); store(VIEW_KEY, JSON.stringify(view)); }
  if (fly) {
    var b = layerOf[s.k][s.id].getBounds(), r = lv ? ZOOM_FOR[lv] : [9, 13];
    var z = Math.min(r[1], Math.max(r[0], map.getBoundsZoom(b, false, L.point(40, 40))));
    map.flyTo(b.getCenter(), z, {duration: 0.6});
  }
  refresh(); renderPanel(); syncHash();
  if (window.matchMedia("(max-width:900px)").matches && !fly) { try { panel.scrollIntoView({behavior: "smooth", block: "start"}); } catch (_) {} }
}

function refreshStyles() {
  ["a", "d", "s"].forEach(function (k) {
    Object.keys(layerOf[k]).forEach(function (id) { var el = layerOf[k][id].getElement(); if (el) el.setAttribute("class", regClass(k, props({k: k, id: id})) + " leaflet-interactive"); });
  });
}

// ---------- карточка дороги ----------
// Объяснение для тех, кто не водит и не бывал в Америке.
var ROAD_TYPES = {
  motorway: ["Фривей", "Скоростное шоссе, вроде нашей автомагистрали. Светофоров и перекрёстков нет, заехать и съехать можно только по развязкам (на указателях они называются exit). Вдоль большинства фривеев идут односторонние улицы-дублёры (frontage road), и уже на них выходят заправки, мотели, фастфуд и торговые центры. Пешком фривей не перейти, только по мосту или под эстакадой. Для пешехода это стена между районами, для машины самый быстрый путь через город."],
  primary: ["Большая улица", "Главная улица района, американцы говорят arterial. Обычно четыре–шесть полос и светофоры на перекрёстках. По сторонам торговые центры с парковками, заправки, рестораны, автобусные остановки. По таким улицам ездят между районами, ночью тут светло и почти всегда кто-то едет."],
  secondary: ["Районная улица", "Улица внутри района: две–четыре полосы, светофоры только на крупных перекрёстках. Ведёт к большим улицам и фривеям."]
};

function plural(n, one, few, many) {
  var a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many;
}

function roadPanel(p) {
  var t = ROAD_TYPES[p.cls] || ["Дорога", ""], facts = [];
  if (p.lanes) facts.push("Около " + p.lanes + " " + plural(p.lanes, "полосы", "полос", "полос") + " в каждую сторону.");
  if (p.speed) facts.push("Ограничение скорости " + p.speed + " миль в час, это около " + Math.round(p.speed * 1.609 / 5) * 5 + " км/ч.");
  if (p.km) facts.push("На карте около " + p.km + " км.");
  var areas = (p.areas || []).filter(function (a) { return featOf.a[a]; });
  return '<div class="pmeta"><span>' + esc(t[0]) + '</span>' + (p.toll ? '<span class="chip">платная</span>' : '') + '</div>' +
    '<h2>' + esc(p.ref || p.name) + '</h2>' +
    (p.ref && p.name ? '<p class="psum">' + esc(p.name) + '</p>' : '') +
    '<div class="pdet"><p>' + esc(t[1]) + '</p>' +
    (p.toll ? '<p>Это платная дорога. В 2005 году за проезд платили наличными в будках на въездах или меткой TollTag на лобовом стекле.</p>' : '') +
    (facts.length ? '<p>' + esc(facts.join(" ")) + '</p>' : '') +
    (p.aka && p.aka.length ? '<p>На разных участках называется ещё ' + esc(p.aka.join(", ")) + '. Местные часто зовут фривеи по именам, а не по номерам.</p>' : '') +
    '</div>' +
    (areas.length ? '<div class="kids"><h3>Проходит через</h3><ul>' + areas.map(function (a) {
      return '<li><button type="button" data-go="a:' + esc(a) + '">' + esc(featOf.a[a].properties.name) + '</button></li>'; }).join("") + '</ul></div>' : '') +
    '<p class="hint" style="margin-top:14px;font-size:12.5px">Полосы и скорость взяты из современных данных OpenStreetMap, в 2005 году где-то могло быть иначе.</p>' +
    '<div class="actions"><button class="btn" type="button" id="p-show">Показать на карте</button></div>';
}

// ---------- карточка региона ----------
function renderPanel() {
  if (!sel) {
    panel.innerHTML = '<div class="pmeta"><span>Даллас, Форт-Уэрт и пригороды · весна 2005</span></div><h2>Карта районов</h2>' +
      '<div class="pdet"><p>Город поделён на регионы трёх масштабов. <b>Крупный</b> — большие области вроде Восточного Далласа или Ирвинга, чтобы понять общий характер места. <b>Средний</b> — районы внутри них. <b>Мелкий</b> — подробные секторы, примерно по полтора–пять квадратных километров.</p>' +
      '<p>В режиме «Авто» масштаб выбирается сам по приближению карты, а кнопками его можно закрепить. Нажми на регион, и здесь откроется описание.</p>' +
      '<p>Режим «Дороги» прячет регионы и показывает фривеи и большие улицы: по клику на дорогу видно, что это за дорога и куда она ведёт.</p>' +
      '<p>К любому региону можно добавить свою метку и заметки: они хранятся только в твоём браузере.</p></div>';
    return;
  }
  if (sel.k === "r") {
    panel.innerHTML = roadPanel(featOf.r[sel.id].properties);
    var rs = sel;
    document.getElementById("p-show").addEventListener("click", function () { select(rs, true); });
    return;
  }
  var s = sel, p = props(s), x = info(s), o = own(s) || {marker: "", label: "", notes: ""}, lv = LEVEL_OF[s.k];
  var ll = labelPt[s.k][s.id] || [0, 0];
  // цепочка: область › район
  var crumbs = [], q = parentOf(s);
  while (q) { crumbs.unshift('<a href="#' + q.k + '/' + esc(q.id) + '" data-go="' + q.k + ':' + esc(q.id) + '">' + esc(props(q).name) + '</a>'); q = parentOf(q); }
  var meta = '<span>' + LEVELS[lv].one + (p.kind && KIND[p.kind] ? ' · ' + KIND[p.kind].toLowerCase() : '') + '</span>' + crumbs.join('<span>›</span>');

  if (editing) {
    var mopts = MARKS.map(function (m) { return '<option value="' + m[0] + '"' + (m[0] === (o.marker || "") ? " selected" : "") + '>' + m[1] + '</option>'; }).join("");
    panel.innerHTML = '<div class="pmeta">' + meta + '</div><h2>' + esc(p.name) + '</h2>' +
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
  // своего текста нет — показываем описание района, в который входит сектор
  var body = (x.details || "").trim() ? '<div class="pdet">' + paras(x.details) + '</div>' : "";
  if (!body) {
    var up = parentOf(s), ux = up ? info(up) : {};
    body = up && (ux.details || "").trim()
      ? '<div class="inherit"><h3>Из описания района «' + esc(props(up).name) + '»</h3>' + paras(ux.details) + '</div>'
      : '<p class="hint">Описания пока нет.</p>';
  }
  var kidsIds = s.k === "a" ? children.a[s.id] : s.k === "d" ? children.d[s.id] : null;
  var kk = s.k === "a" ? "d" : "s", kids = "";
  if (kidsIds && kidsIds.length > 1) {
    var list = kidsIds.slice().sort(function (a, b) { return props({k: kk, id: a}).name.localeCompare(props({k: kk, id: b}).name, "ru"); });
    kids = '<div class="kids"><h3>' + (s.k === "a" ? "Районы" : "Секторы") + ' · ' + list.length + '</h3><ul>' + list.map(function (id) {
      return '<li><button type="button" data-go="' + kk + ':' + esc(id) + '">' + esc(props({k: kk, id: id}).name) + '</button></li>'; }).join("") + '</ul></div>';
  }
  var cells = ["core", "city", "fw"].map(function (b) { var c = gridCell(b, ll[0], ll[1]); return c ? GRIDS[b].label + " " + c : null; }).filter(Boolean);
  panel.innerHTML =
    '<div class="pmeta">' + meta + '</div>' +
    '<h2>' + esc(p.name) + '</h2>' +
    (chips ? '<div class="pmeta" style="margin-bottom:8px">' + chips + '</div>' : '') +
    '<div class="pmeta" style="margin-bottom:12px"><span>≈ ' + String(p.km2).replace(".", ",") + ' км²</span><span>' + dist(ll) + '</span>' +
    (cells.length && gridOn() ? '<span>старая сетка: ' + esc(cells.join(", ")) + '</span>' : '') + '</div>' +
    (x.summary ? '<p class="psum">' + esc(x.summary) + '</p>' : "") + body +
    (x.more && x.more.trim() ? '<details class="pmore" id="p-more"' + (moreOpen[skey(s)] ? " open" : "") + '><summary>Подробнее</summary><div class="pdet">' + paras(x.more) + '</div></details>' : "") +
    (x.notes && x.notes.trim() ? '<div class="notes"><h3>Заметки мастера</h3><p>' + esc(x.notes) + '</p></div>' : "") +
    mineBlock +
    '<div class="actions"><button class="btn primary" type="button" id="p-edit">' + (own(s) ? "Изменить мои пометки" : "Добавить свою пометку") + '</button>' +
    '<button class="btn" type="button" id="p-show">Показать на карте</button>' +
    (status ? '<span class="status">' + esc(status) + '</span>' : "") + '</div>' + kids;
  var pm = document.getElementById("p-more");
  if (pm) pm.addEventListener("toggle", function () { if (pm.open) moreOpen[skey(s)] = 1; else delete moreOpen[skey(s)]; });
  document.getElementById("p-edit").addEventListener("click", function () { editing = true; status = ""; renderPanel(); var t = document.getElementById("f-notes"); if (t) t.focus(); });
  document.getElementById("p-show").addEventListener("click", function () { select(s, true); });
}

panel.addEventListener("click", function (e) {
  var t = e.target.closest("[data-go]"); if (!t) return;
  e.preventDefault();
  var g = t.getAttribute("data-go").split(":");
  select({k: g[0], id: g.slice(1).join(":")}, true);
});

// ---------- поиск ----------
function setupSearch() {
  var q = document.getElementById("q"), box = document.getElementById("results"), all = [];
  [1, 2, 3].forEach(function (lv) {
    var k = LEVELS[lv].k;
    geo[LEVELS[lv].file].features.forEach(function (f) {
      var up = parentOf({k: k, id: f.properties.id});
      all.push({k: k, id: f.properties.id, name: f.properties.name, sub: LEVELS[lv].one.toLowerCase() + (up ? " · " + props(up).name : ""), lv: lv});
    });
  });
  geo.roads.features.forEach(function (f) {
    var p = f.properties; if (!p.id || p.cls === "secondary") return;
    all.push({k: "r", id: p.id, name: roadTitle(p), sub: ROAD_TYPES[p.cls][0].toLowerCase(), lv: 4});
  });
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

// Файл этой карты ({items}) или старой карты в клетку ({cells: {"city:D5": …}}): клетка ложится на район среднего масштаба в её центре.
function importFile(p) {
  var n = 0;
  if (p && p.items && typeof p.items === "object") {
    Object.keys(p.items).forEach(function (k) { var g = k.split(":"); if (featOf[g[0]] && featOf[g[0]][g.slice(1).join(":")]) { mine.items[k] = p.items[k]; n++; } });
    saveMine(); return "Загружено пометок: " + n + ". Совпадающие места заменены пометками из файла.";
  }
  if (p && p.cells && typeof p.cells === "object") {
    Object.keys(p.cells).forEach(function (k) {
      var g = k.split(":"); if (!GRIDS[g[0]]) return;
      var ll = cellCenter(g[0], g[1]), id = regionAt(2, ll[0], ll[1]); if (!id) return;
      var src = p.cells[k], dst = mine.items["d:" + id] || {marker: "", label: "", notes: ""};
      dst.marker = dst.marker || src.marker || "";
      dst.label = dst.label || src.label || "";
      if (src.notes) dst.notes = (dst.notes ? dst.notes + "\n\n" : "") + "[старая клетка " + k + "] " + src.notes;
      mine.items["d:" + id] = dst; n++;
    });
    saveMine(); return "Перенесено пометок со старой карты: " + n + ". Каждая клетка легла на район в её центре.";
  }
  throw new Error("bad");
}

// ---------- ссылки ----------
// #a/<область>, #d/<район>, #s/<сектор>, #r/<дорога>; старые ссылки #city-D5, #core-B4, #fw-E6 открывают район в центре клетки
function syncHash() { try { history.replaceState(null, "", sel ? "#" + sel.k + "/" + sel.id : location.pathname); } catch (_) {} }
function readHash(fly) {
  var h = location.hash || "", m = /^#([adsr])\/(.+)$/.exec(h);
  if (m) { select({k: m[1], id: decodeURIComponent(m[2])}, fly); return; }
  m = /^#(city|core|fw)-([A-I])([1-9])$/.exec(h);
  if (m) { var ll = cellCenter(m[1], m[2] + m[3]), id = regionAt(2, ll[0], ll[1]); if (id) select({k: "d", id: id}, fly); }
}

// ---------- запуск ----------
var files = ["l1", "l2", "l3", "labels", "roads", "water", "rail", "green"];
Promise.all(files.map(function (n) { return fetch(GEO + n + ".geojson").then(function (r) { if (!r.ok) throw new Error(n); return r.json(); }); })
  .concat([fetch("data/map.json", {cache: "no-cache"}).then(function (r) { return r.json(); })]))
.then(function (res) {
  files.forEach(function (n, i) { geo[n] = res[i]; });
  text = res[files.length]; ["areas", "districts", "sectors"].forEach(function (k) { text[k] = text[k] || {}; });
  document.getElementById("loading").remove();
  loadMine(); buildMap(); setupSearch(); renderTools(); renderPanel();
  document.getElementById("lv").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setLevel(b.getAttribute("data-l")); });
  document.getElementById("md").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setMode(b.getAttribute("data-m")); });
  readHash(true);
  window.addEventListener("hashchange", function () { readHash(true); });
}).catch(function () {
  document.getElementById("loading").textContent = "Не удалось загрузить данные карты. Если ты открыл файл прямо с диска, запусти локальный сервер (см. README).";
});
})();
