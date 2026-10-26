/*
 * Карта районов Далласа и Форт-Уэрта 2005 для «Вампиры: Маскарад» (V20).
 * Геометрия лежит в data/geo/*.geojson (её собирает tools/build.py), тексты — в data/map.json.
 * Личные пометки игрока хранятся только в его браузере (localStorage).
 * Подробности устройства: docs/MAP.md
 */
(function () {
"use strict";

var GEO = "data/geo/";
var STORE_KEY = "vtm-dallas-2005-map.personal.v1";
var GRID_KEY = "vtm-dallas-2005-map.grid";
var DETAIL_ZOOM = 12; // с этого масштаба кликаются районы, а не области
var BOUNDS = [[32.58, -97.55], [33.08, -96.50]];
var ORIGIN = [32.8005, -96.8277]; // отель Anatole, от него считаются расстояния
var MARKS = [["", "Без метки"], ["haven", "Убежище"], ["ally", "Союзники"], ["hostile", "Враждебность"], ["important", "Важное место"]];
var MLABEL = {haven: "Убежище", ally: "Союзники", hostile: "Враждебность", important: "Важное место"};
// Сетки старой карты: чтобы показать клетку поверх и открыть старые ссылки вида #city-D5
var GRIDS = {
  city: {cols: 9, rows: 9, n: 33.02, s: 32.62, w: -96.99, e: -96.55, label: "Даллас"},
  core: {cols: 8, rows: 8, n: 32.842222, s: 32.753333, w: -96.843333, e: -96.745556, label: "центр Далласа"},
  fw: {cols: 9, rows: 9, n: 33.00, s: 32.60, w: -97.55, e: -97.11, label: "Форт-Уэрт"}
};
var LET = "ABCDEFGHI";

var geo = {}, text = {areas: {}, districts: {}}, legacy = {cells: {}, districts: {}, areas: {}};
var mine = {items: {}};
var sel = null; // {k: "d"|"a", id}
var editing = false, status = "", toolStatus = "", confirmWipe = false, moreOpen = {};
var map, layerOf = {d: {}, a: {}, r: {}}, featOf = {d: {}, a: {}, r: {}}, labelPt = {d: {}, a: {}};
var selLayer = null, distLayer, areaLayer, dLabels, aLabels, gridLayer, gridLabels;
var panel = document.getElementById("panel"), toolsEl = document.getElementById("tools");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]; }); }
function paras(t) {
  return String(t || "").split(/\n\s*\n/).filter(function (p) { return p.trim(); }).map(function (p) { return "<p>" + esc(p.trim()) + "</p>"; }).join("");
}
function skey(s) { return s.k + ":" + s.id; }
function props(s) { var f = featOf[s.k][s.id]; return f ? f.properties : {}; }
function info(s) { return (s.k === "d" ? text.districts : text.areas)[s.id] || {}; }
function own(s) { return mine.items[skey(s)] || null; }
function marker(s) { var o = own(s); return (o && o.marker) || info(s).marker || ""; }

// ---------- личное хранилище ----------
function loadMine() {
  try { var raw = localStorage.getItem(STORE_KEY); if (raw) { var p = JSON.parse(raw); if (p && p.items) mine = p; } } catch (_) {}
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
function districtAt(lat, lon) {
  var f = geo.districts.features.filter(function (f) { return polyHas(f.geometry, lon, lat); })[0];
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
// Что видно на каком масштабе (как в Google Maps: издалека только главное, детали проявляются при приближении).
// Слой показывается, если zoom >= порога.
var SHOW = {primary: 11, secondary: 13, dart: 11, rail: 12.5, creek: 13, limit: 12.5, distLines: 11.5, roadHit: 9};
var roadVis = {}, roadHit = {}, roadLine = {}, layerByZoom = [];

function buildMap() {
  map = L.map("map", {zoomSnap: 0.5, zoomDelta: 0.5, minZoom: 9, maxZoom: 16, maxBounds: L.latLngBounds(BOUNDS).pad(0.15),
    maxBoundsViscosity: 0.8, attributionControl: true, renderer: L.svg({padding: 0.5})});
  map.attributionControl.setPrefix(false).addAttribution('Геоданные © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, перепись США 2000');
  [["land", 200], ["tint", 220], ["green", 250], ["water", 300], ["dist", 350], ["roads", 400], ["areas", 420], ["roadhit", 425], ["sel", 430], ["grid", 440], ["labels", 450]].forEach(function (p) {
    map.createPane(p[0]).style.zIndex = p[1];
  });
  ["tint", "roads", "grid", "labels"].forEach(function (p) { map.getPane(p).style.pointerEvents = "none"; });

  L.rectangle(BOUNDS, {pane: "land", className: "land", interactive: false}).addTo(map);
  // цвет областей — отдельным неинтерактивным слоем под всем остальным
  L.geoJSON(geo.areas, {pane: "tint", interactive: false, style: function (f) { return {className: "tint t" + (f.properties.tone || 0)}; }}).addTo(map);
  L.geoJSON(geo.green, {pane: "green", interactive: false, style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls !== "creek"; },
    style: function (f) { return {className: f.properties.cls}; }}).addTo(map);
  byZoom(L.geoJSON(geo.water, {pane: "water", interactive: false, filter: function (f) { return f.properties.cls === "creek"; }, style: {className: "creek"}}), SHOW.creek);

  distLayer = L.geoJSON(geo.districts, {pane: "dist", style: function (f) { return {className: distClass(f.properties.id)}; },
    onEachFeature: function (f, l) { hook("d", f, l); }}).addTo(map);
  areaLayer = L.geoJSON(geo.areas, {pane: "areas", style: {className: "area"}, onEachFeature: function (f, l) { hook("a", f, l); }}).addTo(map);

  // дороги: видимая линия + невидимая широкая полоса, по которой удобно попасть мышкой
  ["secondary", "primary", "motorway"].forEach(function (cls) {
    var feats = geo.roads.features.filter(function (f) { return f.properties.cls === cls; });
    roadVis[cls] = L.geoJSON(feats, {pane: "roads", interactive: false, style: {className: "rd rd-" + cls},
      onEachFeature: function (f, l) { if (f.properties.id) roadLine[f.properties.id] = l; }});
    if (cls !== "secondary") {
      roadHit[cls] = L.geoJSON(feats.filter(function (f) { return f.properties.id; }), {pane: "roadhit", style: {className: "rdhit", weight: 14},
        onEachFeature: function (f, l) { hookRoad(f, l); }});
    }
  });
  roadVis.motorway.addTo(map);
  byZoom(roadVis.primary, SHOW.primary);
  byZoom(roadVis.secondary, SHOW.secondary);
  byZoom(roadHit.motorway, SHOW.roadHit);
  byZoom(roadHit.primary, SHOW.primary);
  byZoom(L.geoJSON(geo.rail, {pane: "roads", interactive: false, filter: function (f) { return f.properties.cls === "dart"; }, style: {className: "dart"}}), SHOW.dart);
  byZoom(L.geoJSON(geo.rail, {pane: "roads", interactive: false, filter: function (f) { return f.properties.cls === "rail"; }, style: {className: "rail"}}), SHOW.rail);
  byZoom(L.geoJSON(geo.cities, {pane: "roads", interactive: false, style: {className: "limit"}}), SHOW.limit);

  dLabels = L.layerGroup(); aLabels = L.layerGroup();
  var maxArea = Math.max.apply(null, geo.areas.features.map(function (f) { return f.properties.km2; }));
  geo.labels.features.forEach(function (f) {
    var p = f.properties, ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]], k = p.level === "area" ? "a" : "d";
    labelPt[k][p.id] = ll;
    // у областей размер шрифта зависит от площади: крупные подписаны крупнее
    var size = k === "a" ? (p.km2 > maxArea / 3 || /^(dal|fw)-/.test(p.id) ? "" : p.km2 > maxArea / 8 ? "" : " small") : "";
    var m = L.marker(ll, {pane: "labels", interactive: false, keyboard: false, opacity: 0,
      icon: L.divIcon({className: "lbl lbl-" + k + size, html: "<span>" + esc(p.name) + "</span>", iconSize: null})});
    // важность подписи: части самих Далласа и Форт-Уэрта важнее пригородов того же размера
    m.km2 = p.km2; m.lid = p.id; m.rank = p.km2 * (k !== "a" ? 1 : /^(dal|fw)-center$/.test(p.id) ? 100 : /^(dal|fw)-/.test(p.id) ? 5 : 1);
    (k === "a" ? aLabels : dLabels).addLayer(m);
  });
  aLabels.addTo(map); dLabels.addTo(map);
  buildGrid();

  map.on("zoomend", onZoom);
  // на узком экране весь охват слишком мелкий — начинаем с Далласа
  if (map.getSize().x < 600) map.fitBounds([[32.68, -97.0], [32.95, -96.62]]);
  else map.fitBounds([[32.62, -97.45], [33.02, -96.58]]);
  onZoom();
  window.vtmMap = map; // для отладки из консоли
}

function byZoom(layer, minZoom) { layerByZoom.push([layer, minZoom]); }

function distClass(id) {
  var m = marker({k: "d", id: id});
  return "dist" + (m ? " m-" + m : "");
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

function onZoom() {
  var z = map.getZoom(), el = map.getContainer(), detail = z >= DETAIL_ZOOM;
  el.className = el.className.replace(/\bz\d+\b/g, "").replace(/\b(overview|detail|dl)\b/g, "").trim() +
    " z" + Math.floor(z) + (detail ? " detail" : " overview") + (z >= SHOW.distLines ? " dl" : "");
  layerByZoom.forEach(function (x) { if (z >= x[1]) { if (!map.hasLayer(x[0])) x[0].addTo(map); } else if (map.hasLayer(x[0])) map.removeLayer(x[0]); });
  if (gridLabels) { if (gridOn() && z >= 10.5) gridLabels.addTo(map); else map.removeLayer(gridLabels); }
  placeLabels();
  document.getElementById("lv-a").setAttribute("aria-pressed", detail ? "false" : "true");
  document.getElementById("lv-d").setAttribute("aria-pressed", detail ? "true" : "false");
}

// Подписи без наложения: важные (крупные) ставятся первыми, остальные — только если есть место.
// У района подпись появляется, когда сам район на экране не меньше 34 px.
function placeLabels() {
  var z = map.getZoom(), detail = z >= DETAIL_ZOOM, placed = [];
  var pxPerKm = 256 * Math.pow(2, z) / (40075 * Math.cos(32.8 * Math.PI / 180));
  function fits(m) {
    var el = m.getElement(); if (!el) return false;
    var sp = el.firstChild, w = sp.offsetWidth, h = sp.offsetHeight, p = map.latLngToLayerPoint(m.getLatLng());
    var b = [p.x - w / 2 - 6, p.y - h / 2 - 3, p.x + w / 2 + 6, p.y + h / 2 + 3];
    for (var i = 0; i < placed.length; i++) {
      var o = placed[i];
      if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return false;
    }
    placed.push(b); return true;
  }
  function run(group, active, minSide) {
    var list = []; group.eachLayer(function (m) { list.push(m); });
    list.sort(function (a, b) { return b.rank - a.rank; });
    // выбранное место подписываем всегда
    if (sel) list.sort(function (a, b) { return (b.lid === sel.id) - (a.lid === sel.id); });
    list.forEach(function (m) {
      var show = active && (Math.sqrt(m.km2) * pxPerKm >= minSide || (sel && m.lid === sel.id)) && fits(m);
      if (show !== m._shown) { m._shown = show; m.setOpacity(show ? 1 : 0); }
    });
  }
  run(aLabels, !detail, 0);
  run(dLabels, detail, 34);
}

function gridOn() { try { return localStorage.getItem(GRID_KEY) === "1"; } catch (_) { return false; } }
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
    try { localStorage.setItem(GRID_KEY, t.checked ? "1" : "0"); } catch (_) {}
    if (t.checked) gridLayer.addTo(map); else map.removeLayer(gridLayer);
    onZoom();
  });
}

function select(s, fly) {
  if (!s || !featOf[s.k][s.id]) return;
  sel = s; editing = false; status = "";
  if (selLayer) map.removeLayer(selLayer);
  selLayer = L.geoJSON(featOf[s.k][s.id], {pane: "sel", interactive: false, style: {className: s.k === "r" ? "selroad" : "selpath"}}).addTo(map);
  if (fly) {
    var b = layerOf[s.k][s.id].getBounds();
    map.flyToBounds(b, {maxZoom: s.k === "a" ? DETAIL_ZOOM - 0.5 : s.k === "r" ? 13 : 14, padding: [30, 30], duration: 0.6});
  } else placeLabels();
  renderPanel(); syncHash();
  if (window.matchMedia("(max-width:900px)").matches && !fly) { try { panel.scrollIntoView({behavior: "smooth", block: "start"}); } catch (_) {} }
}

function refreshStyles() {
  Object.keys(layerOf.d).forEach(function (id) { var el = layerOf.d[id].getElement(); if (el) el.setAttribute("class", distClass(id) + " leaflet-interactive"); });
}

// ---------- карточка дороги ----------
// Объяснение для тех, кто не водит и не бывал в Америке.
var ROAD_TYPES = {
  motorway: ["Фривей", "Скоростное шоссе, вроде нашей автомагистрали. Светофоров и перекрёстков нет, заехать и съехать можно только по развязкам (на указателях они называются exit). Вдоль большинства фривеев идут односторонние улицы-дублёры (frontage road), и уже на них выходят заправки, мотели, фастфуд и торговые центры. Пешком фривей не перейти, только по мосту или под эстакадой. Для пешехода это стена между районами, для машины самый быстрый путь через город."],
  primary: ["Большая улица", "Главная улица района, американцы говорят arterial. Обычно четыре–шесть полос и светофоры на перекрёстках. По сторонам торговые центры с парковками, заправки, рестораны, автобусные остановки. По таким улицам ездят между районами, ночью тут светло и почти всегда кто-то едет."],
  secondary: ["Районная улица", "Улица внутри района: две–четыре полосы, светофоры только на крупных перекрёстках. Ведёт к большим улицам и фривеям."]
};

function roadPanel(p) {
  var t = ROAD_TYPES[p.cls] || ["Дорога", ""];
  var facts = [];
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

function plural(n, one, few, many) {
  var a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many;
}

// ---------- карточка ----------
function legacyBlock(keys, title, ll) {
  if (!keys || !keys.length) return "";
  // первой — клетка, где лежит центр района
  var here = ["core", "city", "fw"].map(function (b) { var c = gridCell(b, ll[0], ll[1]); return c ? b + ":" + c : null; });
  keys = keys.slice().sort(function (a, b) { return (here.indexOf(a) < 0) - (here.indexOf(b) < 0); });
  return '<div class="legacybox"><h3>' + title + '</h3><p>Это тексты прежней карты в клетку. Клетка была больше или меньше района, поэтому часть текста может относиться к соседям.</p>' +
    keys.map(function (k, i) {
      var c = legacy.cells[k]; if (!c) return "";
      var parts = k.split(":"), where = GRIDS[parts[0]].label + " " + parts[1];
      return '<details class="legacy"' + (i === 0 ? " open" : "") + '><summary>' + esc(c.name) + '<small>' + esc(where) + '</small></summary>' +
        (c.summary ? '<p class="psum">' + esc(c.summary) + '</p>' : "") + '<div class="pdet">' + paras(c.details) + paras(c.more) + '</div></details>';
    }).join("") + '</div>';
}

function renderPanel() {
  if (!sel) {
    panel.innerHTML = '<div class="pmeta"><span>Даллас, Форт-Уэрт и пригороды · весна 2005</span></div><h2>Карта районов</h2>' +
      '<p class="psum">Издалека город поделён на крупные области, чтобы понять общий характер места. Приблизь карту или нажми «Районы», и области распадутся на районы, нарезанные по настоящим улицам.</p>' +
      '<div class="pdet"><p>Нажми на область или район, и здесь откроется описание. К любому месту можно добавить свою метку и заметки: они хранятся только в твоём браузере.</p>' +
      '<p>Галочка «Старая сетка» накладывает клетки прежней карты, чтобы было проще договариваться по старым обозначениям вроде D5.</p></div>';
    return;
  }
  if (sel.k === "r") {
    panel.innerHTML = roadPanel(featOf.r[sel.id].properties);
    var rs = sel;
    document.getElementById("p-show").addEventListener("click", function () { select(rs, true); });
    return;
  }
  var s = sel, p = props(s), x = info(s), o = own(s) || {marker: "", label: "", notes: ""};
  var ll = labelPt[s.k][s.id] || [0, 0];
  var cells = ["core", "city", "fw"].map(function (b) { var c = gridCell(b, ll[0], ll[1]); return c ? GRIDS[b].label + " " + c : null; }).filter(Boolean);
  var meta = s.k === "d"
    ? '<a href="#a/' + esc(p.area) + '" data-go="a:' + esc(p.area) + '">' + esc(props({k: "a", id: p.area}).name || "") + '</a>' + (p.city && p.city !== props({k: "a", id: p.area}).name ? '<span>' + esc(p.city) + '</span>' : "")
    : '<span>Область</span>';
  meta += '<span>≈ ' + String(p.km2).replace(".", ",") + ' км²</span>';

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
  var kids = "";
  if (s.k === "a") {
    var list = geo.districts.features.filter(function (f) { return f.properties.area === s.id; })
      .sort(function (a, b) { return a.properties.name.localeCompare(b.properties.name, "ru"); });
    kids = '<div class="kids"><h3>Районы области · ' + list.length + '</h3><ul>' + list.map(function (f) {
      return '<li><button type="button" data-go="d:' + esc(f.properties.id) + '">' + esc(f.properties.name) + '</button></li>'; }).join("") + '</ul></div>';
  }
  var hasText = (x.details || "").trim();
  panel.innerHTML =
    '<div class="pmeta">' + meta + chips + '</div>' +
    '<h2>' + esc(p.name) + '</h2>' +
    '<div class="pmeta" style="margin-bottom:10px"><span>' + dist(ll) + '</span>' + (cells.length ? '<span>старая карта: ' + esc(cells.join(", ")) + '</span>' : '') + '</div>' +
    (x.summary ? '<p class="psum">' + esc(x.summary) + '</p>' : "") +
    (hasText ? '<div class="pdet">' + paras(x.details) + '</div>' : '<p class="hint">Нового описания пока нет.</p>') +
    (x.more && x.more.trim() ? '<details class="pmore" id="p-more"' + (moreOpen[skey(s)] ? " open" : "") + '><summary>Подробнее</summary><div class="pdet">' + paras(x.more) + '</div></details>' : "") +
    (x.notes && x.notes.trim() ? '<div class="notes"><h3>Заметки мастера</h3><p>' + esc(x.notes) + '</p></div>' : "") +
    mineBlock +
    '<div class="actions"><button class="btn primary" type="button" id="p-edit">' + (own(s) ? "Изменить мои пометки" : "Добавить свою пометку") + '</button>' +
    '<button class="btn" type="button" id="p-show">Показать на карте</button>' +
    (status ? '<span class="status">' + esc(status) + '</span>' : "") + '</div>' +
    kids +
    (hasText ? "" : legacyBlock((s.k === "d" ? legacy.districts : legacy.areas)[s.id], "Из старой карты", ll));
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
  var q = document.getElementById("q"), box = document.getElementById("results");
  var all = [];
  geo.areas.features.forEach(function (f) { all.push({k: "a", id: f.properties.id, name: f.properties.name, sub: "область"}); });
  geo.districts.features.forEach(function (f) {
    var a = featOf.a[f.properties.area];
    all.push({k: "d", id: f.properties.id, name: f.properties.name, sub: a ? a.properties.name : ""});
  });
  geo.roads.features.forEach(function (f) {
    var p = f.properties; if (!p.id || p.cls === "secondary") return;
    all.push({k: "r", id: p.id, name: roadTitle(p), sub: ROAD_TYPES[p.cls][0].toLowerCase()});
  });
  function norm(s) { return s.toLowerCase().replace(/ё/g, "е").replace(/[-‐\s]+/g, " "); }
  function show() {
    var v = norm(q.value.trim());
    if (!v) { box.hidden = true; return; }
    var hits = all.filter(function (x) { return norm(x.name).indexOf(v) >= 0; })
      .sort(function (a, b) { return norm(a.name).indexOf(v) - norm(b.name).indexOf(v) || a.name.length - b.name.length; }).slice(0, 12);
    box.innerHTML = hits.length ? hits.map(function (x) { return '<button type="button" data-k="' + x.k + '" data-id="' + esc(x.id) + '">' + esc(x.name) + '<small>' + esc(x.sub) + '</small></button>'; }).join("")
      : '<button type="button" disabled>Ничего не нашлось</button>';
    box.hidden = false;
  }
  q.addEventListener("input", show);
  q.addEventListener("focus", show);
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

// Файл новой карты ({items}) или старой карты в клетку ({cells: {"city:D5": …}}): клетка переносится на район в её центре.
function importFile(p) {
  var n = 0;
  if (p && p.items && typeof p.items === "object") {
    Object.keys(p.items).forEach(function (k) { var g = k.split(":"); if (featOf[g[0]] && featOf[g[0]][g.slice(1).join(":")]) { mine.items[k] = p.items[k]; n++; } });
    saveMine(); return "Загружено пометок: " + n + ". Совпадающие места заменены пометками из файла.";
  }
  if (p && p.cells && typeof p.cells === "object") {
    Object.keys(p.cells).forEach(function (k) {
      var g = k.split(":"); if (!GRIDS[g[0]]) return;
      var ll = cellCenter(g[0], g[1]), id = districtAt(ll[0], ll[1]); if (!id) return;
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
// #d/<район>, #a/<область>; старые ссылки #city-D5, #core-B4, #fw-E6 открывают район в центре клетки
function syncHash() { try { history.replaceState(null, "", sel ? "#" + sel.k + "/" + sel.id : location.pathname); } catch (_) {} }
function readHash(fly) {
  var h = location.hash || "", m = /^#([dar])\/(.+)$/.exec(h);
  if (m) { select({k: m[1], id: decodeURIComponent(m[2])}, fly); return; }
  m = /^#(city|core|fw)-([A-I])([1-9])$/.exec(h);
  if (m) { var ll = cellCenter(m[1], m[2] + m[3]), id = districtAt(ll[0], ll[1]); if (id) select({k: "d", id: id}, fly); }
}

// ---------- запуск ----------
var files = ["districts", "areas", "labels", "roads", "water", "rail", "green", "cities"];
Promise.all(files.map(function (n) { return fetch(GEO + n + ".geojson").then(function (r) { if (!r.ok) throw new Error(n); return r.json(); }); })
  .concat([fetch("data/map.json", {cache: "no-cache"}).then(function (r) { return r.json(); }),
    fetch(GEO + "legacy.json").then(function (r) { return r.ok ? r.json() : legacy; }).catch(function () { return legacy; })]))
.then(function (res) {
  files.forEach(function (n, i) { geo[n] = res[i]; });
  text = res[files.length]; text.areas = text.areas || {}; text.districts = text.districts || {};
  legacy = res[files.length + 1];
  document.getElementById("loading").remove();
  loadMine(); buildMap(); setupSearch(); renderTools(); renderPanel();
  document.getElementById("lv-a").addEventListener("click", function () {
    if (sel && sel.k === "d") { var a = props(sel).area; select({k: "a", id: a}, true); } else map.flyTo(map.getCenter(), DETAIL_ZOOM - 2, {duration: 0.5});
  });
  document.getElementById("lv-d").addEventListener("click", function () {
    if (sel) {
      var b = layerOf[sel.k][sel.id].getBounds();
      map.flyTo(b.getCenter(), Math.min(14, Math.max(DETAIL_ZOOM, map.getBoundsZoom(b, false, L.point(60, 60)))), {duration: 0.5});
    } else map.flyTo(map.getCenter(), Math.max(DETAIL_ZOOM + 0.5, map.getZoom()), {duration: 0.5});
  });
  readHash(true);
  window.addEventListener("hashchange", function () { readHash(true); });
}).catch(function (e) {
  document.getElementById("loading").textContent = "Не удалось загрузить данные карты. Если ты открыл файл прямо с диска, запусти локальный сервер (см. README).";
});
})();
