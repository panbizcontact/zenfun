/* ZENFUN 全墳マップ 本体ロジック */
(function () {
  "use strict";

  const CFG = window.ZENFUN_CONFIG || {};
  const IS_AUTH = CFG.isAuthenticated;
  const IS_ADMIN = CFG.isAdmin;
  const SHAPES = CFG.shapes || {};
  // このズーム未満: 透明度のある丸で表現。このズーム以上: 輪郭Pathがあればそれを表示
  // (未登録の古墳は丸のまま)。
  const OUTLINE_ZOOM = 11;

  // ── 地図の初期化: 国土地理院タイル ──
  // 陰影起伏図で地形（山・平野・海）を、淡色地図で道路・注記を重ねる。
  const GSI_ATTR =
    '地理院タイル（<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>）';

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        gsi_hillshade: {
          type: "raster",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png"],
          tileSize: 256, minzoom: 2, maxzoom: 16, attribution: GSI_ATTR,
        },
        gsi_pale: {
          type: "raster",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
          tileSize: 256, minzoom: 2, maxzoom: 18, attribution: GSI_ATTR,
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#c9d3d6" } },
        { id: "hillshade", type: "raster", source: "gsi_hillshade" },
        // 淡色地図を薄く重ねて道路・地名を出す（陰影の地形感を残す）
        { id: "pale", type: "raster", source: "gsi_pale", paint: { "raster-opacity": 0.55 } },
      ],
    },
    center: [135.78, 34.55], // 大和・河内あたり（古墳の密集地）
    zoom: 9,
    maxZoom: 18, minZoom: 4,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

  // ── 状態 ──
  let currentItems = [];     // 現在の取得結果
  let fetchTimer = null;
  let currentDetailId = null;

  // ── 古墳データの取得（範囲＋ズーム＋絞り込み） ──
  function currentFilters() {
    return {
      q: document.getElementById("q").value.trim(),
      prefecture: document.getElementById("f-pref").value,
      shape: document.getElementById("f-shape").value,
      period: document.getElementById("f-period").value.trim(),
      min_length: document.getElementById("f-minlen").value.trim(),
      max_length: document.getElementById("f-maxlen").value.trim(),
    };
  }

  function fetchKofun() {
    const b = map.getBounds();
    const params = new URLSearchParams({
      min_lat: b.getSouth(), max_lat: b.getNorth(),
      min_lng: b.getWest(),  max_lng: b.getEast(),
      zoom: Math.round(map.getZoom()),
    });
    const f = currentFilters();
    Object.entries(f).forEach(([k, v]) => { if (v) params.set(k, v); });

    fetch("/api/kofun?" + params.toString())
      .then((r) => r.json())
      .then((data) => {
        currentItems = data.items;
        renderMapLayers(data.items);
        renderList(data.items, data.count);
      })
      .catch(() => flash("データの取得に失敗しました。", "error"));
  }

  function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchKofun, 250);
  }

  // ── 地図描画: ズーム1〜10は透明度のある丸、ズーム11以上は輪郭Path（あれば） ──
  function renderMapLayers(items) {
    const src = map.getSource("kofun-src");
    const outlineSrc = map.getSource("kofun-outline-src");
    if (!src || !outlineSrc) return; // map "load" 前は無視（load 後に再取得される）

    src.setData({
      type: "FeatureCollection",
      features: items.map((k) => ({
        type: "Feature",
        properties: { id: k.id, has_outline: !!k.has_outline },
        geometry: { type: "Point", coordinates: [k.lng, k.lat] },
      })),
    });

    const outlineFeatures = [];
    items.forEach((k) => {
      if (!k.outline) return;
      // 周堤(複数可。外側・内側)を先に、墳丘を後に積んで墳丘が上に見えるようにする
      (k.outline.moats || []).forEach((m) => {
        const outerOk = m.outer && m.outer.length >= 3;
        const innerOk = m.inner && m.inner.length >= 3;
        if (outerOk && innerOk) {
          outlineFeatures.push(moatRingFeature(k.id, m.outer, m.inner));
        } else if (outerOk) {
          outlineFeatures.push(ringFeature(k.id, "moat", m.outer));
        } else if (innerOk) {
          outlineFeatures.push(ringFeature(k.id, "moat", m.inner));
        }
      });
      if (k.outline.mound && k.outline.mound.length >= 3) {
        outlineFeatures.push(ringFeature(k.id, "mound", k.outline.mound));
      }
      (k.outline.lines || []).forEach((l) => {
        if (l.length >= 2) {
          outlineFeatures.push({
            type: "Feature", properties: { id: k.id, kind: "line" },
            geometry: { type: "LineString", coordinates: l },
          });
        }
      });
    });
    outlineSrc.setData({ type: "FeatureCollection", features: outlineFeatures });
  }

  function closeRing(ring) {
    const coords = ring.slice();
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return coords;
  }

  function ringFeature(id, kind, ring) {
    return {
      type: "Feature",
      properties: { id, kind },
      geometry: { type: "Polygon", coordinates: [closeRing(ring)] },
    };
  }

  // 周堤: 外側の輪の中に内側の輪を「穴」として持たせ、その間の輪状の領域を描く
  function moatRingFeature(id, outer, inner) {
    return {
      type: "Feature",
      properties: { id, kind: "moat" },
      geometry: { type: "Polygon", coordinates: [closeRing(outer), closeRing(inner)] },
    };
  }

  // ── リスト描画（左パネル） ──
  function renderList(items, count) {
    const ul = document.getElementById("result-list");
    ul.innerHTML = "";
    document.getElementById("result-count").textContent = count + " 基";
    items.slice(0, 300).forEach((k) => {
      const li = document.createElement("li");
      const sub = [k.prefecture, k.shape_ja, k.length_m ? k.length_m + "m" : ""]
        .filter(Boolean).join(" ・ ");
      li.innerHTML =
        `<span class="rl-mark">${window.KofunMarkers.kofunMarkerSVG(k.shape, 26, k.orientation_deg)}</span>` +
        `<span><span class="rl-name">${escapeHtml(k.name)}</span><br>` +
        `<span class="rl-sub">${escapeHtml(sub)}</span></span>`;
      li.addEventListener("click", () => {
        map.flyTo({ center: [k.lng, k.lat], zoom: Math.max(map.getZoom(), 13) });
        openDetail(k.id);
      });
      ul.appendChild(li);
    });
  }

  // ── 詳細パネル ──
  function openDetail(id) {
    currentDetailId = id;
    document.getElementById("d-history-list").style.display = "none";
    document.getElementById("d-history-toggle").textContent = "編集履歴を見る";
    fetch("/api/kofun/" + id).then((r) => r.json()).then((k) => {
      const color = window.KofunMarkers.SHAPE_COLORS[k.shape] || "#7a736a";
      document.getElementById("d-mark").innerHTML =
        window.KofunMarkers.kofunMarkerSVG(k.shape, 44, k.orientation_deg);
      document.getElementById("d-name").textContent = k.name;
      document.getElementById("d-kana").textContent = k.name_kana || "";

      const badges = document.getElementById("d-badges");
      badges.innerHTML =
        `<span class="badge shape" style="background:${color}">${k.shape_ja}</span>` +
        (k.designation ? `<span class="badge">${escapeHtml(k.designation)}</span>` : "") +
        (k.data_source === "wikipedia" ? `<span class="badge">Wikipedia</span>` : "");

      const rows = [
        ["所在地", [k.prefecture, k.municipality].filter(Boolean).join(" ")],
        ["墳丘長", k.length_m ? k.length_m + " m" : "—"],
        ["墳丘高", k.height_m ? k.height_m + " m" : "—"],
        ["主軸方位", window.KofunMarkers.hasOrientation(k.shape)
          ? Math.round(k.orientation_deg) + "°（" + degToJa(k.orientation_deg) + "）" : "—"],
        ["築造年代", periodText(k)],
        ["座標", k.lat.toFixed(5) + ", " + k.lng.toFixed(5)],
      ];
      document.getElementById("d-table").innerHTML = rows
        .map(([t, v]) => `<tr><th>${t}</th><td>${escapeHtml(String(v))}</td></tr>`).join("");
      document.getElementById("d-desc").textContent = k.description || "";

      const src = document.getElementById("d-source");
      if (k.source_url) { src.href = k.source_url; src.style.display = ""; }
      else { src.style.display = "none"; }

      const editBtn = document.getElementById("d-edit");
      if (IS_AUTH) { editBtn.style.display = ""; editBtn.onclick = () => openEditor(k); }
      else { editBtn.style.display = "none"; }

      const deleteBtn = document.getElementById("d-delete");
      if (IS_AUTH) { deleteBtn.style.display = ""; deleteBtn.onclick = () => requestDelete(k); }
      else { deleteBtn.style.display = "none"; }

      document.getElementById("detail-panel").classList.add("open");
    });
  }
  document.getElementById("d-close").onclick = () =>
    document.getElementById("detail-panel").classList.remove("open");

  // ── 削除（管理者は即時削除、一般会員は承認申請） ──
  function requestDelete(k) {
    const msg = IS_ADMIN
      ? `「${k.name}」を削除します。よろしいですか？`
      : `「${k.name}」の削除を管理者に申請します。よろしいですか？`;
    if (!confirm(msg)) return;
    apiRequest("/api/kofun/" + k.id, { method: "DELETE" }).then(({ ok, status, d }) => {
      if (!ok) { flash(d.error || "処理に失敗しました。", "error"); return; }
      if (status === 202) { flash(d.message, "success"); return; }
      flash("削除しました。", "success");
      document.getElementById("detail-panel").classList.remove("open");
      fetchKofun();
    });
  }

  // ── 編集履歴・差し戻し ──
  document.getElementById("d-history-toggle").onclick = () => {
    const ul = document.getElementById("d-history-list");
    const opening = ul.style.display === "none";
    if (opening) loadHistory(currentDetailId);
    ul.style.display = opening ? "" : "none";
    document.getElementById("d-history-toggle").textContent =
      opening ? "編集履歴を閉じる" : "編集履歴を見る";
  };

  const ACTION_JA = { create: "追加", update: "編集", delete: "削除", revert: "差し戻し" };

  function loadHistory(id) {
    fetch(`/api/kofun/${id}/history`).then((r) => r.json()).then((items) => {
      const ul = document.getElementById("d-history-list");
      if (!items.length) { ul.innerHTML = "<li>履歴はありません。</li>"; return; }
      ul.innerHTML = items.map((h) => {
        const canRevert = IS_ADMIN && h.has_snapshot;
        return `<li>${fmtDate(h.created_at)}・${ACTION_JA[h.action] || h.action}・${escapeHtml(h.username)}` +
          (canRevert ? `<button class="link-btn" data-hist="${h.id}">差し戻す</button>` : "") +
          `</li>`;
      }).join("");
      ul.querySelectorAll("button[data-hist]").forEach((btn) => {
        btn.onclick = () => revertHistory(id, btn.dataset.hist);
      });
    });
  }

  function revertHistory(kofunId, histId) {
    if (!confirm("この版に差し戻しますか？")) return;
    apiRequest(`/api/kofun/${kofunId}/history/${histId}/revert`, { method: "POST" })
      .then(({ ok, d }) => {
        if (!ok) { flash(d.error || "差し戻しに失敗しました。", "error"); return; }
        flash("差し戻しました。", "success");
        fetchKofun();
        openDetail(kofunId);
      });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso + "Z").toLocaleString("ja-JP");
  }

  // ── 共通 fetch ラッパー: 429(レート制限)を統一的に扱う ──
  function apiRequest(url, opts) {
    return fetch(url, opts).then((r) => {
      if (r.status === 429) {
        flash("操作が多すぎます。しばらく時間を置いてから再度お試しください。", "error");
        return { ok: false, status: 429, d: {} };
      }
      return r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} }));
    });
  }

  // ── 追加・編集モーダル ──
  function openEditor(k) {
    const isNew = !k;
    k = k || { shape: "unknown", orientation_deg: 0 };
    document.getElementById("modal-title").textContent = isNew ? "古墳を追加" : "古墳を編集";
    const form = document.getElementById("kofun-form");
    form.reset();
    form.dataset.id = isNew ? "" : k.id;
    setVal("m-name", k.name); setVal("m-kana", k.name_kana);
    setVal("m-lat", k.lat); setVal("m-lng", k.lng);
    setVal("m-pref", k.prefecture); setVal("m-muni", k.municipality);
    setVal("m-shape", k.shape); setVal("m-length", k.length_m);
    setVal("m-height", k.height_m); setVal("m-orient", k.orientation_deg || 0);
    setVal("m-period", k.period); setVal("m-yfrom", k.year_from); setVal("m-yto", k.year_to);
    setVal("m-designation", k.designation); setVal("m-source", k.source_url);
    setVal("m-desc", k.description);
    // 新規で座標未設定なら地図中心を初期値に
    if (isNew) {
      const c = map.getCenter();
      setVal("m-lat", c.lat.toFixed(6)); setVal("m-lng", c.lng.toFixed(6));
    }
    updateOrientDial();
    updateOrientMapBtn();
    outlineDraft = {
      mound: (k.outline && k.outline.mound) ? k.outline.mound.slice() : [],
      moats: (k.outline && k.outline.moats)
        ? k.outline.moats.map((m) => ({ outer: (m.outer || []).slice(), inner: (m.inner || []).slice() }))
        : [],
      lines: (k.outline && k.outline.lines) ? k.outline.lines.map((l) => l.slice()) : [],
    };
    outlineActiveTarget = "mound";
    updateOutlineStatus();
    document.getElementById("modal-overlay").classList.add("open");
  }

  document.getElementById("kofun-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.dataset.id;
    const outlineObj = {};
    if (outlineDraft.mound.length >= 3) outlineObj.mound = outlineDraft.mound;
    const validMoats = outlineDraft.moats
      .map((m) => {
        const entry = {};
        if (m.outer.length >= 3) entry.outer = m.outer;
        if (m.inner.length >= 3) entry.inner = m.inner;
        return entry;
      })
      .filter((entry) => entry.outer || entry.inner);
    if (validMoats.length) outlineObj.moats = validMoats;
    const validLines = outlineDraft.lines.filter((l) => l.length >= 2);
    if (validLines.length) outlineObj.lines = validLines;
    const payload = {
      name: val("m-name"), name_kana: val("m-kana"),
      latitude: val("m-lat"), longitude: val("m-lng"),
      prefecture: val("m-pref"), municipality: val("m-muni"),
      shape: val("m-shape"), length_m: val("m-length"), height_m: val("m-height"),
      orientation_deg: val("m-orient"),
      period: val("m-period"), year_from: val("m-yfrom"), year_to: val("m-yto"),
      designation: val("m-designation"), source_url: val("m-source"),
      description: val("m-desc"),
      outline_geojson: Object.keys(outlineObj).length ? JSON.stringify(outlineObj) : "",
    };
    const url = id ? "/api/kofun/" + id : "/api/kofun";
    const method = id ? "PUT" : "POST";
    apiRequest(url, {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(({ ok, status, d }) => {
      if (!ok) { flash(d.error || "保存に失敗しました。", "error"); return; }
      if (status === 202) {
        flash(d.message, "success");
        closeModal();
        return;
      }
      flash(id ? "更新しました。" : "追加しました。", "success");
      closeModal();
      fetchKofun();
      openDetail(d.id);
    });
  });

  function closeModal() {
    document.getElementById("modal-overlay").classList.remove("open");
    exitMapOrientMode();
    exitOutlineDrawMode();
  }
  document.getElementById("m-cancel").onclick = closeModal;
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });

  // 方角ダイヤル・地図上ハンドルの表示更新（どちらから操作しても同期する）
  function updateOrientDial() {
    const deg = parseFloat(val("m-orient")) || 0;
    const label = Math.round(deg) + "° " + degToJa(deg);
    document.getElementById("orient-needle").setAttribute("transform", `rotate(${deg} 32 32)`);
    document.getElementById("orient-label").textContent = label;
    document.getElementById("orient-map-readout").textContent = label;
    if (orientMapMarker) orientMapMarker.setRotation(deg);
  }
  document.getElementById("m-orient").addEventListener("input", updateOrientDial);

  function updateOrientMapBtn() {
    const s = val("m-shape");
    const wrap = document.getElementById("orient-field");
    wrap.style.opacity = window.KofunMarkers.hasOrientation(s) ? "1" : "0.4";
    document.getElementById("orient-map-btn").disabled = !window.KofunMarkers.hasOrientation(s);
  }
  document.getElementById("m-shape").addEventListener("change", updateOrientMapBtn);

  // ── 地図上でドラッグして方位を回転設定 ──
  // モーダルを一時的に隠し、地図全体を見ながら対象地点のハンドルをドラッグ操作する。
  let orientMapMarker = null;
  let orientDragging = false;

  function orientHandleSVG() {
    return `
<svg width="46" height="46" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <polygon points="32,4 25,30 39,30" fill="#9e3b2e" stroke="#23201c" stroke-width="2.5" stroke-linejoin="round"/>
  <polygon points="32,60 25,34 39,34" fill="#3c3833" stroke="#23201c" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="32" cy="32" r="9" fill="#fff8ec" stroke="#23201c" stroke-width="2.5"/>
</svg>`.trim();
  }

  function wireOrientDrag(el) {
    function angleFromEvent(e) {
      const point = e.touches ? e.touches[0] : e;
      const rect = map.getCanvasContainer().getBoundingClientRect();
      const mx = point.clientX - rect.left;
      const my = point.clientY - rect.top;
      const center = map.project(orientMapMarker.getLngLat());
      const dx = mx - center.x;
      const dy = my - center.y;
      if (Math.hypot(dx, dy) < 4) return null; // 中心付近はノイズになるため無視
      return (Math.atan2(dx, -dy) * 180) / Math.PI;
    }
    function onMove(e) {
      if (!orientDragging) return;
      const deg = angleFromEvent(e);
      if (deg !== null) {
        document.getElementById("m-orient").value = ((deg % 360) + 360) % 360;
        updateOrientDial();
      }
      e.preventDefault();
    }
    function onUp() {
      orientDragging = false;
      el.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    }
    function onDown(e) {
      orientDragging = true;
      el.classList.add("dragging");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
      e.preventDefault();
      e.stopPropagation(); // 地図自体のドラッグ(パン)を起こさない
    }
    el.addEventListener("mousedown", onDown);
    el.addEventListener("touchstart", onDown, { passive: false });
  }

  function enterMapOrientMode() {
    const lat = parseFloat(val("m-lat"));
    const lng = parseFloat(val("m-lng"));
    if (isNaN(lat) || isNaN(lng)) return;
    document.getElementById("modal-overlay").classList.remove("open");
    document.getElementById("orient-map-toolbar").classList.add("open");
    // 検索・詳細パネルを一時的に隠し、地図全面を使えるようにする
    document.body.classList.add("map-edit-mode");
    map.panTo([lng, lat], { duration: 300 });

    const el = document.createElement("div");
    el.className = "orient-map-marker";
    el.innerHTML = orientHandleSVG();
    orientMapMarker = new maplibregl.Marker({
      element: el, anchor: "center", rotationAlignment: "map", pitchAlignment: "map",
    }).setLngLat([lng, lat]).addTo(map);
    orientMapMarker.setRotation(parseFloat(val("m-orient")) || 0);
    wireOrientDrag(el);
  }

  function exitMapOrientMode() {
    document.getElementById("orient-map-toolbar").classList.remove("open");
    document.body.classList.remove("map-edit-mode");
    if (orientMapMarker) { orientMapMarker.remove(); orientMapMarker = null; }
  }

  document.getElementById("orient-map-btn").addEventListener("click", () => {
    if (document.getElementById("orient-map-btn").disabled) return;
    enterMapOrientMode();
  });
  document.getElementById("orient-map-done").addEventListener("click", () => {
    exitMapOrientMode();
    document.getElementById("modal-overlay").classList.add("open");
  });

  // ── 輪郭（墳丘・周堤）を地図上のクリックで描く ──
  // 周堤(moat)は二重・三重の周濠を持つ古墳もあるため複数持てる。各周堤は外側・内側の
  // 輪を別々になぞり、両方あれば間の輪状の領域、片方だけならその輪単体を面として保存する。
  // line は閉じないただの線（赤）として複数持てる。
  let outlineDraft = { mound: [], moats: [], lines: [] };  // moats: [{outer:[], inner:[]}, ...]
  let outlineActiveTarget = "mound"; // "mound" | "moat:<i>:outer" | "moat:<i>:inner" | "line:<i>"

  function outlineActiveRing() {
    if (outlineActiveTarget === "mound") return outlineDraft.mound;
    const parts = outlineActiveTarget.split(":");
    if (parts[0] === "moat") {
      const m = outlineDraft.moats[parseInt(parts[1], 10)];
      return m ? m[parts[2]] : null;
    }
    if (parts[0] === "line") {
      return outlineDraft.lines[parseInt(parts[1], 10)] || null;
    }
    return null;
  }

  function updateOutlineStatus() {
    const parts = [];
    if (outlineDraft.mound.length >= 3) parts.push(`墳丘${outlineDraft.mound.length}点`);
    const validMoats = outlineDraft.moats.filter((m) => m.outer.length >= 3 || m.inner.length >= 3);
    if (validMoats.length) parts.push(`周堤${validMoats.length}`);
    const validLines = outlineDraft.lines.filter((l) => l.length >= 2);
    if (validLines.length) parts.push(`線${validLines.length}本`);
    document.getElementById("outline-status").textContent =
      parts.length ? parts.join(" / ") + " 設定済み" : "未設定";
    document.getElementById("outline-clear-btn").style.display = parts.length ? "" : "none";
  }
  document.getElementById("outline-clear-btn").addEventListener("click", () => {
    if (!confirm("輪郭の設定をクリアしますか？")) return;
    outlineDraft = { mound: [], moats: [], lines: [] };
    updateOutlineStatus();
  });

  function updateOutlineDraftLayer() {
    const src = map.getSource("outline-draft-src");
    if (!src) return;
    const features = [];
    function addRing(pts, kind, closeIt) {
      if (pts.length >= 2) {
        const coords = (closeIt && pts.length >= 3) ? pts.concat([pts[0]]) : pts;
        features.push({
          type: "Feature", properties: { kind, role: "line" },
          geometry: { type: "LineString", coordinates: coords },
        });
      }
      pts.forEach((p) => {
        features.push({
          type: "Feature", properties: { kind, role: "vertex" },
          geometry: { type: "Point", coordinates: p },
        });
      });
    }
    addRing(outlineDraft.mound, "mound", true);
    outlineDraft.moats.forEach((m) => {
      addRing(m.outer, "moat", true);
      addRing(m.inner, "moat", true);
    });
    outlineDraft.lines.forEach((l) => addRing(l, "line", false));
    src.setData({ type: "FeatureCollection", features });
    const ring = outlineActiveRing();
    document.getElementById("outline-point-count").textContent = (ring ? ring.length : 0) + "点";
  }

  // 対象（墳丘 / 周堤N：外側・内側 / 線N）の切り替えボタンを都度組み立てる
  function renderOutlineTargets() {
    const wrap = document.getElementById("outline-targets");
    wrap.innerHTML = "";
    const addToggle = (label, target) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.classList.toggle("active", outlineActiveTarget === target);
      b.addEventListener("click", () => {
        outlineActiveTarget = target;
        renderOutlineTargets();
        updateOutlineDraftLayer();
      });
      wrap.appendChild(b);
    };
    const addDelete = (label, onClick) => {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = label;
      del.addEventListener("click", onClick);
      wrap.appendChild(del);
    };

    addToggle("墳丘の輪郭", "mound");
    outlineDraft.moats.forEach((m, i) => {
      addToggle(`周堤${i + 1}：外側`, `moat:${i}:outer`);
      addToggle(`周堤${i + 1}：内側`, `moat:${i}:inner`);
      addDelete(`周堤${i + 1}を削除`, () => {
        outlineDraft.moats.splice(i, 1);
        if (outlineActiveTarget.startsWith(`moat:${i}:`)) outlineActiveTarget = "mound";
        renderOutlineTargets();
        updateOutlineDraftLayer();
      });
    });
    outlineDraft.lines.forEach((l, i) => {
      addToggle(`線${i + 1}`, `line:${i}`);
      addDelete(`線${i + 1}を削除`, () => {
        outlineDraft.lines.splice(i, 1);
        if (outlineActiveTarget === `line:${i}`) outlineActiveTarget = "mound";
        renderOutlineTargets();
        updateOutlineDraftLayer();
      });
    });

    const addMoatBtn = document.createElement("button");
    addMoatBtn.type = "button";
    addMoatBtn.className = "add";
    addMoatBtn.textContent = "＋ 周堤を追加";
    addMoatBtn.addEventListener("click", () => {
      outlineDraft.moats.push({ outer: [], inner: [] });
      outlineActiveTarget = `moat:${outlineDraft.moats.length - 1}:outer`;
      renderOutlineTargets();
      updateOutlineDraftLayer();
    });
    wrap.appendChild(addMoatBtn);

    const addLineBtn = document.createElement("button");
    addLineBtn.type = "button";
    addLineBtn.className = "add";
    addLineBtn.textContent = "＋ 線を追加";
    addLineBtn.addEventListener("click", () => {
      outlineDraft.lines.push([]);
      outlineActiveTarget = `line:${outlineDraft.lines.length - 1}`;
      renderOutlineTargets();
      updateOutlineDraftLayer();
    });
    wrap.appendChild(addLineBtn);
  }

  document.getElementById("outline-undo").addEventListener("click", () => {
    const ring = outlineActiveRing();
    if (ring) ring.pop();
    updateOutlineDraftLayer();
  });
  document.getElementById("outline-clear-shape").addEventListener("click", () => {
    const ring = outlineActiveRing();
    if (ring) ring.length = 0;
    updateOutlineDraftLayer();
  });

  function onOutlineMapClick(e) {
    const ring = outlineActiveRing();
    if (!ring) return;
    ring.push([e.lngLat.lng, e.lngLat.lat]);
    updateOutlineDraftLayer();
  }

  function enterOutlineDrawMode() {
    document.getElementById("modal-overlay").classList.remove("open");
    document.getElementById("outline-map-toolbar").classList.add("open");
    document.body.classList.add("map-edit-mode");
    const lat = parseFloat(val("m-lat"));
    const lng = parseFloat(val("m-lng"));
    if (!isNaN(lat) && !isNaN(lng)) map.panTo([lng, lat], { duration: 300 });
    outlineActiveTarget = "mound";
    renderOutlineTargets();
    updateOutlineDraftLayer();
    map.on("click", onOutlineMapClick);
  }

  function exitOutlineDrawMode() {
    map.off("click", onOutlineMapClick);
    document.getElementById("outline-map-toolbar").classList.remove("open");
    document.body.classList.remove("map-edit-mode");
    const src = map.getSource("outline-draft-src");
    if (src) src.setData({ type: "FeatureCollection", features: [] });
    updateOutlineStatus();
  }

  document.getElementById("outline-map-btn").addEventListener("click", enterOutlineDrawMode);
  document.getElementById("outline-done").addEventListener("click", () => {
    exitOutlineDrawMode();
    document.getElementById("modal-overlay").classList.add("open");
  });

  // 追加ボタン
  const addBtn = document.getElementById("btn-add");
  if (addBtn) addBtn.onclick = () => IS_AUTH ? openEditor(null)
    : (location.href = "/auth/login");

  // ── フィルタ操作 ──
  ["q", "f-pref", "f-shape", "f-period", "f-minlen", "f-maxlen"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", scheduleFetch);
    el.addEventListener("change", scheduleFetch);
  });

  // ── 地図イベント ──
  map.on("moveend", scheduleFetch);
  map.on("load", () => {
    setupMapLayers();
    const flyToId = new URLSearchParams(location.search).get("flyto");
    if (flyToId) {
      flyToKofun(flyToId);
    } else {
      fetchKofun();
    }
  });

  // ── レビュー画面などからの「地図で見る」リンク対応 ──
  // 規模フィルタに関わらず対象の古墳へ寄って詳細を開く（?flyto=<id>）。
  function flyToKofun(id) {
    fetch("/api/kofun/" + id).then((r) => {
      if (!r.ok) throw new Error("not found");
      return r.json();
    }).then((k) => {
      map.jumpTo({ center: [k.lng, k.lat], zoom: 15 });
      fetchKofun();
      openDetail(k.id);
    }).catch(() => {
      flash("指定された古墳が見つかりませんでした。", "error");
      fetchKofun();
    });
  }

  // ── 地図レイヤーのセットアップ（1回だけ） ──
  function setupMapLayers() {
    // 古墳の位置（円）。ズーム11未満は全件、11以上は輪郭Path未登録のものだけ。
    map.addSource("kofun-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: OUTLINE_ZOOM,
      clusterRadius: 50,
    });
    // 輪郭Path（墳丘・周堤）。ズーム11以上のみ表示。
    map.addSource("kofun-outline-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    // 輪郭を描いている最中のプレビュー
    map.addSource("outline-draft-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "clusters", type: "circle", source: "kofun-src",
      filter: ["has", "point_count"],
      maxzoom: OUTLINE_ZOOM,
      paint: {
        "circle-color": ["step", ["get", "point_count"], "#a9863f", 50, "#9e3b2e", 200, "#5a2b22"],
        "circle-radius": ["step", ["get", "point_count"], 16, 50, 22, 200, 28],
        "circle-opacity": 0.55,
        "circle-stroke-width": 2, "circle-stroke-color": "#fff8ec", "circle-stroke-opacity": 0.9,
      },
    });
    map.addLayer({
      id: "kofun-circles", type: "circle", source: "kofun-src",
      filter: ["!", ["has", "point_count"]],
      maxzoom: OUTLINE_ZOOM,
      paint: {
        "circle-color": "#9e3b2e", "circle-opacity": 0.45,
        "circle-radius": 6,
        "circle-stroke-width": 1.5, "circle-stroke-color": "#9e3b2e", "circle-stroke-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "kofun-circles-hi", type: "circle", source: "kofun-src",
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "has_outline"], false]],
      minzoom: OUTLINE_ZOOM,
      paint: {
        "circle-color": "#9e3b2e", "circle-opacity": 0.45,
        "circle-radius": 7,
        "circle-stroke-width": 1.5, "circle-stroke-color": "#9e3b2e", "circle-stroke-opacity": 0.85,
      },
    });
    // 墳丘・周堤・線とも同じ赤(#9e3b2e)。重なりが見えるよう周堤は不透明度を下げる。
    map.addLayer({
      id: "kofun-outline-fill", type: "fill", source: "kofun-outline-src",
      minzoom: OUTLINE_ZOOM,
      filter: ["!=", ["get", "kind"], "line"],
      paint: {
        "fill-color": "#9e3b2e",
        "fill-opacity": ["match", ["get", "kind"], "moat", 0.3, 0.55],
      },
    });
    map.addLayer({
      id: "kofun-outline-line", type: "line", source: "kofun-outline-src",
      minzoom: OUTLINE_ZOOM,
      filter: ["!=", ["get", "kind"], "line"],
      paint: { "line-color": "#9e3b2e", "line-width": 1.5 },
    });
    // 単純な線（ただの赤い線として描く）
    map.addLayer({
      id: "kofun-outline-userline", type: "line", source: "kofun-outline-src",
      minzoom: OUTLINE_ZOOM,
      filter: ["==", ["get", "kind"], "line"],
      paint: { "line-color": "#9e3b2e", "line-width": 2.5 },
    });

    // 輪郭の描画中プレビュー
    map.addLayer({
      id: "outline-draft-line", type: "line", source: "outline-draft-src",
      filter: ["==", ["get", "role"], "line"],
      paint: { "line-color": "#9e3b2e", "line-width": 2, "line-dasharray": [2, 1] },
    });
    map.addLayer({
      id: "outline-draft-points", type: "circle", source: "outline-draft-src",
      filter: ["==", ["get", "role"], "vertex"],
      paint: {
        "circle-radius": 5, "circle-color": "#9e3b2e",
        "circle-stroke-width": 2, "circle-stroke-color": "#fff8ec",
      },
    });

    map.on("click", "clusters", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
      const clusterId = features[0].properties.cluster_id;
      map.getSource("kofun-src").getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });
    const openFromFeature = (e) => openDetail(e.features[0].properties.id);
    ["kofun-circles", "kofun-circles-hi", "kofun-outline-fill", "kofun-outline-userline"].forEach((id) => {
      map.on("click", id, openFromFeature);
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    });
    map.on("mouseenter", "clusters", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; });
  }

  // ── ユーティリティ ──
  function val(id) { const v = document.getElementById(id).value.trim(); return v === "" ? null : v; }
  function setVal(id, v) { document.getElementById(id).value = (v ?? "") === null ? "" : (v ?? ""); }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function degToJa(deg) {
    const dirs = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }
  function periodText(k) {
    if (k.year_from || k.year_to) {
      const f = k.year_from != null ? fmtYear(k.year_from) : "";
      const t = k.year_to != null ? fmtYear(k.year_to) : "";
      return (k.period ? k.period + " " : "") + [f, t].filter(Boolean).join("〜");
    }
    return k.period || "—";
  }
  function fmtYear(y) { return y < 0 ? "前" + (-y) : y + ""; }

  window.zenfunFlash = flash;
  function flash(msg, type) {
    const box = document.getElementById("flash");
    const el = document.createElement("div");
    el.className = "flash-item " + (type || "success");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
})();
