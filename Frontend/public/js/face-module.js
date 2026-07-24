/**
 * Face Recognition module — dashboard, database, enrollment, alerts.
 */
(function () {
  const slug = document.body.dataset.detectionSlug;
  if (slug !== 'face') return;

  let dashboard = null;
  let persons = [];
  let groups = [];
  let alerts = [];
  let activeTab = 'overview';
  let dbSearch = '';
  let dbGroupFilter = '';
  let dbSort = 'fullName';
  let dbPage = 1;
  const PAGE_SIZE = 12;
  let selectedIds = new Set();
  let dashWs = null;
  let boardStatus = null;
  let boardPersons = [];
  let enrollBanner = null;
  let clusters = [];
  let clusterThreshold = 0.55;
  let clustersLoading = false;
  let clustersError = null;
  let clusterDetailId = null;
  let lastClusterRefreshAt = 0;
  const CLUSTER_REFRESH_MS = 2500;

  function showToast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('ov-toast-success', 'ov-toast-error');
    if (type === 'success') el.classList.add('ov-toast-success');
    if (type === 'error') el.classList.add('ov-toast-error');
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show', 'ov-toast-success', 'ov-toast-error'), 4000);
  }

  function showEnrollBanner(type, title, detail) {
    enrollBanner = { type, title, detail };
    const host = document.getElementById('faceEnrollBanner');
    if (!host) return;
    host.hidden = false;
    host.className = `ov-face-enroll-banner is-${type}`;
    host.innerHTML = `
      <div class="ov-face-enroll-banner-icon">${type === 'success' ? '✓' : '!'}</div>
      <div>
        <strong>${esc(title)}</strong>
        <p>${esc(detail)}</p>
      </div>`;
    if (type === 'success') {
      setTimeout(() => { enrollBanner = null; if (host) host.hidden = true; }, 12000);
    }
  }

  function clearEnrollBanner() {
    enrollBanner = null;
    const host = document.getElementById('faceEnrollBanner');
    if (host) host.hidden = true;
  }

  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function groupName(id) {
    return groups.find((g) => g.id === id)?.name || id || '—';
  }

  function groupColor(id) {
    return groups.find((g) => g.id === id)?.color || '#64748b';
  }

  function authBadge(status) {
    const map = {
      authorized: 'ov-badge-success',
      unauthorized: 'ov-badge-error',
      pending: 'ov-badge-accent',
    };
    return `<span class="ov-badge ${map[status] || 'ov-badge-gold'}">${esc(status || 'pending')}</span>`;
  }

  function enrollStatusBadge(count) {
    if ((count || 0) > 0) {
      return '<span class="ov-badge ov-badge-success">Face enrolled</span>';
    }
    return '<span class="ov-badge ov-badge-error">No face data</span>';
  }

  function severityBadge(sev) {
    const map = {
      critical: 'ov-badge-error',
      warning: 'ov-badge-accent',
      info: 'ov-badge-gold',
      success: 'ov-badge-success',
      vip: 'ov-badge-vip',
      unauthorized: 'ov-badge-unauthorized',
      blacklist: 'ov-badge-blacklist',
      known: 'ov-badge-known',
      unknown: 'ov-badge-unknown',
    };
    return `<span class="ov-badge ${map[sev] || 'ov-badge-gold'}">${esc(sev)}</span>`;
  }

  function afterEnrollResult(data) {
    const person = data.person;
    const emb = data.embeddingCount || person?.embeddingCount || 0;
    if (data.enrolled && emb > 0) {
      showEnrollBanner(
        'success',
        `${person.fullName} enrolled successfully`,
        `${emb} face embedding saved on board — open live view to recognize this person`
      );
      showToast(`✓ ${person.fullName} enrolled`, 'success');
      activeTab = 'database';
    } else {
      showEnrollBanner(
        'error',
        'Person saved — face not enrolled on board',
        data.error || data.message || 'Check board is online, then View → Re-sync'
      );
      showToast(data.error || 'Face not enrolled on board', 'error');
      activeTab = 'database';
    }
  }

  async function submitEnroll(body, submitBtn) {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.prevLabel = submitBtn.textContent;
      submitBtn.textContent = 'Enrolling…';
    }
    clearEnrollBanner();
    try {
      const res = await fetch(sessionUrl('/api/face/persons'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try { data = await res.json(); } catch {
        showEnrollBanner('error', 'Enrollment failed', 'Server error — try a smaller photo or restart dashboard');
        showToast('Server error — image may be too large', 'error');
        return false;
      }
      if (!res.ok && !data.person) {
        showEnrollBanner('error', 'Enrollment failed', data.error || 'Unknown error');
        showToast(data.error || 'Enrollment failed', 'error');
        return false;
      }
      afterEnrollResult(data);
      return true;
    } catch {
      showEnrollBanner('error', 'Network error', 'Could not reach server');
      showToast('Network error', 'error');
      return false;
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.prevLabel || 'Create & enroll';
      }
    }
  }

  function renderStatCards() {
    const s = dashboard?.statistics || {};
    return `
      <div class="ov-face-stats-grid ov-plive-stats" style="margin:0 20px 16px;border-radius:var(--radius-md);">
        <div class="ov-face-stat-card"><div class="ov-face-stat-val">${s.totalPersons ?? 0}</div><div class="ov-face-stat-lbl">Enrolled persons</div></div>
        <div class="ov-face-stat-card"><div class="ov-face-stat-val">${s.enrolledWithEmbeddings ?? 0}</div><div class="ov-face-stat-lbl">With face data</div></div>
        <div class="ov-face-stat-card"><div class="ov-face-stat-val">${s.authorized ?? 0}</div><div class="ov-face-stat-lbl">Authorized</div></div>
        <div class="ov-face-stat-card"><div class="ov-face-stat-val">${s.activeAlerts ?? 0}</div><div class="ov-face-stat-lbl">Active alerts</div></div>
        <div class="ov-face-stat-card"><div class="ov-face-stat-val">${dashboard?.faceMetrics?.facesNow ?? 0}</div><div class="ov-face-stat-lbl">Faces now</div></div>
        <div class="ov-face-stat-card"><div class="ov-face-stat-val">${dashboard?.faceMetrics?.recognitionsToday ?? 0}</div><div class="ov-face-stat-lbl">Recognitions today</div></div>
      </div>`;
  }

  function renderOverview() {
    const events = dashboard?.recentEvents || [];
    const recentAlerts = dashboard?.recentAlerts || [];
    return `
      ${renderStatCards()}
      <div class="ov-face-overview-grid">
        <article class="ov-card ov-face-panel">
          <div class="ov-merged-head"><h3>Recognition activity</h3></div>
          <div class="ov-merged-divider"></div>
          <div class="ov-face-timeline">
            ${events.length ? events.slice(0, 8).map((e) => `
              <div class="ov-face-timeline-item">
                <div class="ov-face-timeline-dot ${e.severity === 'critical' ? 'is-critical' : ''}"></div>
                <div>
                  <div class="ov-face-timeline-title">${esc(e.title)}</div>
                  <div class="ov-face-timeline-meta">${esc(e.camera)} · ${esc(e.timeLabel)} ${e.personName ? `· ${esc(e.personName)}` : ''}</div>
                </div>
              </div>`).join('') : '<p class="ov-det-empty">No recognition events yet.</p>'}
          </div>
        </article>
        <article class="ov-card ov-face-panel">
          <div class="ov-merged-head"><h3>Recent alerts</h3></div>
          <div class="ov-merged-divider"></div>
          <div class="ov-face-alert-list">
            ${recentAlerts.length ? recentAlerts.slice(0, 6).map((a) => `
              <div class="ov-face-alert-row" data-alert-id="${a.id}">
                <div>${severityBadge(a.severity)} <strong>${esc(a.title)}</strong></div>
                <div class="ov-face-alert-meta">${esc(a.cameraName)} · ${new Date(a.createdAt).toLocaleTimeString()}</div>
              </div>`).join('') : '<p class="ov-det-empty">No active alerts.</p>'}
          </div>
        </article>
      </div>`;
  }

  function renderDatabase() {
    const filtered = persons.filter((p) => {
      if (dbGroupFilter && p.groupId !== dbGroupFilter) return false;
      if (!dbSearch) return true;
      const q = dbSearch.toLowerCase();
      return [p.fullName, p.personId, p.department, p.role].some((v) => String(v).toLowerCase().includes(q));
    });
    filtered.sort((a, b) => {
      const av = (a[dbSort] || '').toString().toLowerCase();
      const bv = (b[dbSort] || '').toString().toLowerCase();
      return av.localeCompare(bv);
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (dbPage > totalPages) dbPage = totalPages;
    const pageItems = filtered.slice((dbPage - 1) * PAGE_SIZE, dbPage * PAGE_SIZE);

    return `
      <div class="ov-face-db-toolbar">
        <input type="search" class="ov-det-input" id="faceDbSearch" placeholder="Search persons…" value="${esc(dbSearch)}">
        <select class="ov-det-select" id="faceDbGroupFilter">
          <option value="">All groups</option>
          ${groups.map((g) => `<option value="${g.id}" ${dbGroupFilter === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
        <select class="ov-det-select" id="faceDbSort">
          <option value="fullName" ${dbSort === 'fullName' ? 'selected' : ''}>Sort: Name</option>
          <option value="personId" ${dbSort === 'personId' ? 'selected' : ''}>Sort: Person ID</option>
          <option value="department" ${dbSort === 'department' ? 'selected' : ''}>Sort: Department</option>
          <option value="createdAt" ${dbSort === 'createdAt' ? 'selected' : ''}>Sort: Created</option>
        </select>
        <button type="button" class="ov-cam-add-btn" id="faceAddPersonBtn">+ Add person</button>
        <button type="button" class="ov-quick-btn" id="faceBulkDeleteBtn" ${selectedIds.size ? '' : 'disabled'}>Delete selected (${selectedIds.size})</button>
      </div>
      <div class="ov-face-db-grid">
        ${pageItems.length ? pageItems.map((p) => `
          <article class="ov-face-person-card" data-person-id="${p.id}">
            <label class="ov-face-person-check"><input type="checkbox" data-select-person="${p.id}" ${selectedIds.has(p.id) ? 'checked' : ''}></label>
            <div class="ov-face-person-avatar" style="background:${groupColor(p.groupId)}22">
              ${p.profileImageUrl ? `<img src="${sessionUrl(p.profileImageUrl)}" alt="">` : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>'}
            </div>
            <div class="ov-face-person-body">
              <div class="ov-face-person-name">${esc(p.fullName)}</div>
              <div class="ov-face-person-meta">${esc(p.personId || '—')} · ${esc(groupName(p.groupId))}</div>
              <div class="ov-face-person-tags">${authBadge(p.authorizationStatus)} ${enrollStatusBadge(p.embeddingCount)} <span class="ov-badge ov-badge-gold">${p.embeddingCount || 0} embeddings</span></div>
            </div>
            <div class="ov-face-person-actions">
              <button type="button" class="ov-quick-btn" data-action="view-person" data-id="${p.id}">View</button>
              <button type="button" class="ov-quick-btn" data-action="edit-person" data-id="${p.id}">Edit</button>
              <button type="button" class="ov-quick-btn ov-det-remove-btn" data-action="delete-person" data-id="${p.id}">Delete</button>
            </div>
          </article>`).join('') : '<p class="ov-det-empty">No persons enrolled. Use Enrollment to add faces.</p>'}
      </div>
      <div class="ov-face-pagination">
        <button type="button" class="ov-quick-btn" id="faceDbPrev" ${dbPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${dbPage} of ${totalPages} · ${filtered.length} persons</span>
        <button type="button" class="ov-quick-btn" id="faceDbNext" ${dbPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
      ${renderBoardClusters()}`;
  }

  function isUnknownBoardPerson(p) {
    const name = String(p.name || '').toLowerCase();
    return name.startsWith('unknown') || name.startsWith('cluster') || !name.trim();
  }

  function renderBoardClusters() {
    if (!boardPersons.length) {
      return `
        <article class="ov-card ov-face-panel" style="margin-top:16px">
          <div class="ov-merged-head"><h3>Board identity clusters</h3><p class="ov-merged-sub">Each enrolled face on the vision board is one cluster — rename unknowns here</p></div>
          <div class="ov-merged-divider"></div>
          <p class="ov-det-empty">No board persons yet — enroll on the board or start live recognition.</p>
        </article>`;
    }
    return `
      <article class="ov-card ov-face-panel" style="margin-top:16px">
        <div class="ov-merged-head"><h3>Board identity clusters</h3><p class="ov-merged-sub">One person = one cluster on the board. Rename unknown clusters below.</p></div>
        <div class="ov-merged-divider"></div>
        <div class="ov-face-db-grid">
          ${boardPersons.map((p) => `
            <article class="ov-face-person-card ${isUnknownBoardPerson(p) ? 'is-unknown-cluster' : ''}" data-board-person-id="${esc(p.person_id)}">
              <div class="ov-face-person-body">
                <div class="ov-face-person-name">${esc(p.name || 'Unknown')}</div>
                <div class="ov-face-person-meta">${esc(p.person_id)} · ${p.embedding_count || 0} embedding(s)</div>
                ${p.note ? `<div class="ov-face-person-meta">${esc(p.note)}</div>` : ''}
              </div>
              <div class="ov-face-person-actions">
                <input class="ov-det-input" type="text" placeholder="Give name…" value="${esc(p.name || '')}" data-board-rename="${esc(p.person_id)}">
                <button type="button" class="ov-quick-btn" data-action="save-board-name" data-id="${esc(p.person_id)}">Save</button>
              </div>
            </article>`).join('')}
        </div>
      </article>`;
  }

  function renderEnrollment() {
    const boardLine = boardStatus
      ? (boardStatus.boardReachable
        ? `<span class="ov-badge ov-badge-success">Vision API online</span> · ${boardStatus.enrolledOnBoard} faces enrolled`
        : `<span class="ov-badge ov-badge-error">Vision API offline</span> — connect the new backend to enable live recognition`)
      : '';
    return `
      <div id="faceEnrollBanner" class="ov-face-enroll-banner" hidden></div>
      ${boardLine ? `<div class="ov-face-board-status">${boardLine}</div>` : ''}
      <div class="ov-face-enroll-grid">
        <article class="ov-card ov-face-panel">
          <div class="ov-merged-head"><h3>Manual person entry</h3></div>
          <div class="ov-merged-divider"></div>
          <form id="faceManualForm" class="ov-face-form">
            <label>Full name<input class="ov-det-input" name="fullName" required></label>
            <label>Person ID<input class="ov-det-input" name="personId"></label>
            <label>Group<select class="ov-det-select" name="groupId">${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
            <label>Role / Category<input class="ov-det-input" name="role"></label>
            <label>Department<input class="ov-det-input" name="department"></label>
            <label>Email<input class="ov-det-input" name="email" type="email"></label>
            <label>Phone<input class="ov-det-input" name="phone"></label>
            <label>Authorization<select class="ov-det-select" name="authorizationStatus"><option value="authorized">Authorized</option><option value="pending">Pending</option><option value="unauthorized">Unauthorized</option></select></label>
            <label>Notes<textarea class="ov-det-input" name="notes" rows="2"></textarea></label>
            <label>Profile image<input type="file" name="image" accept="image/*"></label>
            <button type="submit" class="ov-cam-add-btn">Create & enroll</button>
          </form>
        </article>
        <article class="ov-card ov-face-panel">
          <div class="ov-merged-head"><h3>Upload single image</h3></div>
          <div class="ov-merged-divider"></div>
          <form id="faceSingleUploadForm" class="ov-face-form">
            <label>Full name<input class="ov-det-input" name="fullName" required></label>
            <label>Group<select class="ov-det-select" name="groupId">${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
            <label>Face image<input type="file" name="image" accept="image/*" required></label>
            <button type="submit" class="ov-quick-btn">Upload & enroll</button>
          </form>
          <div class="ov-merged-divider" style="margin:20px 0"></div>
          <div class="ov-merged-head"><h3>Bulk upload</h3><p class="ov-merged-sub">Select multiple images — name from filename</p></div>
          <form id="faceBulkForm" class="ov-face-form">
            <label>Default group<select class="ov-det-select" name="groupId">${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
            <label>Images<input type="file" name="images" accept="image/*" multiple required></label>
            <button type="submit" class="ov-quick-btn">Bulk enroll</button>
          </form>
          <div class="ov-merged-divider" style="margin:20px 0"></div>
          <div class="ov-merged-head"><h3>Import database</h3></div>
          <form id="faceImportForm" class="ov-face-form">
            <label>JSON file<input type="file" name="file" accept="application/json,.json" required></label>
            <button type="submit" class="ov-quick-btn">Import</button>
          </form>
        </article>
        <article class="ov-card ov-face-panel">
          <div class="ov-merged-head"><h3>Capture from camera</h3><p class="ov-merged-sub">Use the live view above, then capture a frame</p></div>
          <div class="ov-merged-divider"></div>
          <form id="faceCaptureForm" class="ov-face-form">
            <label>Full name<input class="ov-det-input" name="fullName" required></label>
            <label>Group<select class="ov-det-select" name="groupId">${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
            <label>Assign to person (optional)<select class="ov-det-select" name="existingId"><option value="">New person</option>${persons.map((p) => `<option value="${p.id}">${esc(p.fullName)}</option>`).join('')}</select></label>
            <button type="button" class="ov-quick-btn" id="faceCaptureBtn">Capture from live stream</button>
            <div id="faceCapturePreview" class="ov-face-capture-preview"></div>
            <button type="submit" class="ov-cam-add-btn" id="faceCaptureEnrollBtn" disabled>Enroll captured face</button>
          </form>
        </article>
      </div>`;
  }

  function cropUrl(filename, clusterId) {
    if (!filename) return '';
    let path = `/api/face/crops/${encodeURIComponent(filename)}`;
    const sid = sessionStorage.getItem('atomoSessionId');
    const params = new URLSearchParams();
    if (sid) params.set('sessionId', sid);
    if (clusterId) params.set('clusterId', clusterId);
    const q = params.toString();
    return q ? `${path}?${q}` : path;
  }

  function formatRelativeTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 60) return 'Just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderClustersTab() {
    const offline = clustersError && !clusters.length;
    return `
      <section class="ov-face-clusters">
        <div class="ov-face-clusters-hero">
          <div>
            <h3 class="ov-face-clusters-title">Name unknown faces</h3>
            <p class="ov-face-clusters-sub">
              Live Face recognition se same unknown person ki photos yahan ek bunch mein aati hain.
              Sirf usi insan ki pics ek group mein — naam do, agle baar pehchan ho jayegi.
            </p>
          </div>
          <div class="ov-face-clusters-tools">
            <label class="ov-face-clusters-thresh">
              <span>Match sensitivity</span>
            <input type="range" id="faceClusterThresh" min="0.40" max="0.85" step="0.01" value="${Number(clusterThreshold).toFixed(2)}">
              <strong id="faceClusterThreshVal">${Number(clusterThreshold).toFixed(2)}</strong>
            </label>
            <button type="button" class="ov-quick-btn" id="faceClustersRefreshBtn"${clustersLoading ? ' disabled' : ''}>
              ${clustersLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        <div class="ov-face-clusters-howto">
          <div><span>1</span> Start Face live recognition</div>
          <div><span>2</span> Same unknown face groups here</div>
          <div><span>3</span> Type a name → Save</div>
        </div>

        ${offline ? `<p class="ov-det-empty ov-face-clusters-error">${esc(clustersError || 'Vision board offline — start the board to collect clusters.')}</p>` : ''}

        ${!offline && !clusters.length ? `
          <div class="ov-face-clusters-empty">
            <div class="ov-face-clusters-empty-art" aria-hidden="true"></div>
            <h4>No unknown groups yet</h4>
            <p>Run Face live view. Jab koi naya face baar‑baar aaye, yahan photos ka bunch dikhega — usko naam de do.</p>
          </div>` : ''}

        <div class="ov-face-clusters-grid">
          ${clusters.map((c) => {
            const preview = c.preview_crop || c.crops?.[0]?.filename;
            const thumbs = (c.crops || []).slice(0, 4);
            return `
              <article class="ov-face-cluster-card" data-cluster-id="${esc(c.id)}">
                <button type="button" class="ov-face-cluster-preview" data-action="open-cluster" data-id="${esc(c.id)}" aria-label="Open cluster">
                  ${preview
                    ? `<img src="${cropUrl(preview, c.id)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.15">`
                    : `<div class="ov-face-cluster-ph">?</div>`}
                  <span class="ov-face-cluster-count">${c.seen_count || 0}× seen</span>
                </button>
                <div class="ov-face-cluster-thumbs">
                  ${thumbs.map((crop) => `<img src="${cropUrl(crop.filename || crop.id, c.id)}" alt="" loading="lazy" decoding="async">`).join('')}
                </div>
                <div class="ov-face-cluster-meta">
                  <div><strong>${esc((c.cameras || []).join(', ') || 'Camera')}</strong></div>
                  <div class="ov-face-cluster-time">Last seen ${esc(formatRelativeTime(c.last_seen_at))}</div>
                </div>
                <form class="ov-face-cluster-nameform" data-cluster-label="${esc(c.id)}">
                  <input class="ov-det-input" name="name" type="text" placeholder="e.g. Rahul · Visitor desk" required autocomplete="off">
                  <select class="ov-det-select" name="groupId">
                    ${groups.map((g) => `<option value="${g.id}" ${g.id === 'visitors' ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
                  </select>
                  <button type="submit" class="ov-cam-add-btn">Save name</button>
                </form>
                <div class="ov-face-cluster-actions">
                  <button type="button" class="ov-quick-btn" data-action="open-cluster" data-id="${esc(c.id)}">View photos</button>
                  <button type="button" class="ov-quick-btn ov-det-remove-btn" data-action="discard-cluster" data-id="${esc(c.id)}">Discard</button>
                </div>
              </article>`;
          }).join('')}
        </div>
      </section>

      <div class="ov-modal" id="faceClusterModal" hidden>
        <div class="ov-modal-backdrop" data-close-cluster-modal></div>
        <div class="ov-modal-dialog ov-face-cluster-modal" role="dialog" aria-modal="true">
          <button type="button" class="ov-modal-close" data-close-cluster-modal>&times;</button>
          <div id="faceClusterModalBody"></div>
        </div>
      </div>`;
  }

  function renderAlertsTab() {
    return `
      <div class="ov-face-db-toolbar">
        <input type="search" class="ov-det-input" id="faceAlertSearch" placeholder="Search alerts…">
        <select class="ov-det-select" id="faceAlertStatus"><option value="">All</option><option value="active">Active</option><option value="acknowledged">Acknowledged</option></select>
        <button type="button" class="ov-quick-btn" id="faceAckAllBtn">Acknowledge all active</button>
      </div>
      <div class="ov-face-alerts-table">
        ${alerts.length ? alerts.map((a) => `
          <article class="ov-face-alert-card ${a.status === 'active' ? 'is-active' : ''}" data-alert-id="${a.id}">
            <div class="ov-face-alert-card-head">
              ${severityBadge(a.severity)}
              <strong>${esc(a.title)}</strong>
              <span class="ov-badge ${a.status === 'active' ? 'ov-badge-accent' : 'ov-badge-success'}">${esc(a.status)}</span>
            </div>
            <p class="ov-face-alert-msg">${esc(a.message)}</p>
            <div class="ov-face-alert-meta">${esc(a.cameraName)} · ${esc(a.location)} · ${new Date(a.createdAt).toLocaleString()}${a.personName ? ` · ${esc(a.personName)}` : ''}</div>
            ${a.status === 'active' ? `<button type="button" class="ov-quick-btn" data-action="ack-alert" data-id="${a.id}">Acknowledge</button>` : `<span class="ov-face-ack-info">Acknowledged ${a.acknowledgedAt ? new Date(a.acknowledgedAt).toLocaleString() : ''}</span>`}
          </article>`).join('') : '<p class="ov-det-empty">No alerts recorded.</p>'}
      </div>`;
  }

  function renderShell() {
    const root = document.getElementById('faceModuleRoot');
    if (!root) return;
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'clusters', label: 'Name faces' },
      { id: 'database', label: 'Face database' },
      { id: 'enrollment', label: 'Enrollment' },
      { id: 'alerts', label: 'Alerts' },
    ];
    root.innerHTML = `
      <article class="ov-card ov-face-module">
        <div class="ov-face-tab-bar">
          ${tabs.map((t) => {
            const badge = t.id === 'clusters' && clusters.length
              ? ` <span class="ov-face-tab-badge">${clusters.length}</span>`
              : '';
            return `<button type="button" class="ov-face-tab ${activeTab === t.id ? 'is-active' : ''}" data-face-tab="${t.id}">${t.label}${badge}</button>`;
          }).join('')}
        </div>
        <div class="ov-merged-divider"></div>
        <div class="ov-face-tab-body" id="faceTabBody">
          ${activeTab === 'overview' ? renderOverview() : ''}
          ${activeTab === 'clusters' ? renderClustersTab() : ''}
          ${activeTab === 'database' ? renderDatabase() : ''}
          ${activeTab === 'enrollment' ? renderEnrollment() : ''}
          ${activeTab === 'alerts' ? renderAlertsTab() : ''}
        </div>
      </article>
      <div class="ov-modal" id="facePersonModal" hidden>
        <div class="ov-modal-backdrop" data-close-modal></div>
        <div class="ov-modal-dialog ov-face-modal-dialog" role="dialog" aria-modal="true">
          <button type="button" class="ov-modal-close" data-close-modal>&times;</button>
          <div id="facePersonModalBody"></div>
        </div>
      </div>`;
    bindEvents();
    if (enrollBanner && activeTab === 'enrollment') {
      showEnrollBanner(enrollBanner.type, enrollBanner.title, enrollBanner.detail);
    }
  }

  async function compressImageFile(file, maxWidth = 960) {
    if (!file || !file.type?.startsWith('image/')) return null;
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxWidth / (img.width || maxWidth));
        const w = Math.max(1, Math.round((img.width || maxWidth) * scale));
        const h = Math.max(1, Math.round((img.height || maxWidth) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Invalid image')); };
      img.src = url;
    });
  }

  async function readFileAsBase64(file) {
    if (!file?.size) return null;
    try {
      return await compressImageFile(file);
    } catch {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }
  }

  let capturedImage = null;

  async function loadClusters() {
    clustersLoading = true;
    clustersError = null;
    try {
      const res = await fetch(sessionUrl('/api/face/clusters'));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep last known groups so a brief auth/network blip does not empty the tab.
        clustersError = data.error || 'Could not load clusters';
      } else {
        clusters = Array.isArray(data.clusters) ? data.clusters : [];
        if (Number.isFinite(Number(data.threshold))) clusterThreshold = Number(data.threshold);
        clustersError = null;
      }
    } catch (err) {
      clustersError = err.message || 'Board offline';
    } finally {
      clustersLoading = false;
      lastClusterRefreshAt = Date.now();
    }
  }

  /** Keep Name faces tab live while detections stream in. */
  async function refreshClustersIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now - lastClusterRefreshAt < CLUSTER_REFRESH_MS) return false;
    if (clustersLoading) return false;
    const sigOf = (list) => list.map((c) => `${c.id}:${c.seen_count || 0}:${(c.crops || []).length}`).join('|');
    const prevSig = sigOf(clusters);
    await loadClusters();
    return prevSig !== sigOf(clusters);
  }

  async function loadDashboard() {
    const res = await fetch(sessionUrl('/api/face/dashboard'));
    if (!res.ok) return;
    dashboard = await res.json();
    groups = dashboard.groups || [];
  }

  async function loadPersons() {
    const q = dbSearch ? `?q=${encodeURIComponent(dbSearch)}` : '';
    const res = await fetch(sessionUrl(`/api/face/persons${q}`));
    if (!res.ok) return;
    const data = await res.json();
    persons = data.persons || [];
    if (data.statistics) dashboard = { ...(dashboard || {}), statistics: data.statistics };
  }

  async function loadAlerts() {
    const res = await fetch(sessionUrl('/api/face/alerts'));
    if (!res.ok) return;
    const data = await res.json();
    alerts = data.alerts || [];
  }

  async function loadBoardPersons() {
    try {
      const res = await fetch(sessionUrl('/api/face/board/persons'));
      if (res.ok) {
        const data = await res.json();
        boardPersons = data.persons || [];
      }
    } catch {
      boardPersons = [];
    }
  }

  async function loadBoardStatus() {
    try {
      const res = await fetch(sessionUrl('/api/face/board-status'));
      if (res.ok) boardStatus = await res.json();
    } catch {
      boardStatus = null;
    }
  }

  async function reload() {
    await Promise.all([
      loadDashboard(),
      loadPersons(),
      loadAlerts(),
      loadBoardStatus(),
      loadBoardPersons(),
      loadClusters(),
    ]);
    if (persons.length === 0 && activeTab === 'overview') {
      activeTab = 'enrollment';
    }
    renderShell();
  }

  async function openPersonModal(person) {
    const modal = document.getElementById('facePersonModal');
    const body = document.getElementById('facePersonModalBody');
    if (!modal || !body) return;

    let verify = null;
    try {
      const res = await fetch(sessionUrl(`/api/face/persons/${person.id}/verify`));
      if (res.ok) verify = await res.json();
    } catch { /* ignore */ }

    const statusHtml = verify ? `
      <div class="ov-face-verify-box" style="margin:12px 0;padding:12px;border-radius:8px;background:${verify.readyForRecognition ? '#f0fdf4' : '#fef2f2'};border:1px solid ${verify.readyForRecognition ? '#bbf7d0' : '#fecaca'}">
        <strong>${verify.readyForRecognition ? '✓ Ready for recognition' : '⚠ Not ready'}</strong>
        <p style="margin:6px 0 0;font-size:13px">${esc(verify.message)}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#64748b">Local: ${verify.localEmbeddings} · Board: ${verify.boardEmbeddings} · Worker: ${verify.workerRunning ? 'running' : 'off'}</p>
        ${!verify.readyForRecognition ? `<button type="button" class="ov-quick-btn" id="faceResyncBtn" style="margin-top:8px">Re-sync to board</button>` : ''}
      </div>` : '';

    body.innerHTML = `
      <h2>${esc(person.fullName)}</h2>
      ${statusHtml}
      <div class="ov-face-profile-grid">
        <div class="ov-face-profile-image">${person.profileImageUrl ? `<img src="${sessionUrl(person.profileImageUrl)}" alt="">` : 'No image'}</div>
        <dl class="ov-face-profile-dl">
          <dt>Person ID</dt><dd>${esc(person.personId || '—')}</dd>
          <dt>Group</dt><dd>${esc(groupName(person.groupId))}</dd>
          <dt>Role</dt><dd>${esc(person.role || '—')}</dd>
          <dt>Department</dt><dd>${esc(person.department || '—')}</dd>
          <dt>Contact</dt><dd>${esc(person.contact?.email || '—')} · ${esc(person.contact?.phone || '—')}</dd>
          <dt>Authorization</dt><dd>${authBadge(person.authorizationStatus)}</dd>
          <dt>Face status</dt><dd>${enrollStatusBadge(person.embeddingCount)}</dd>
          <dt>Embeddings</dt><dd>${person.embeddingCount || 0}</dd>
          <dt>Board ID</dt><dd>${esc(person.backendPersonId || '—')}</dd>
          <dt>Created</dt><dd>${person.createdAt ? new Date(person.createdAt).toLocaleString() : '—'}</dd>
          <dt>Last seen</dt><dd>${person.lastSeen ? `${esc(person.lastSeen.cameraName)} · ${new Date(person.lastSeen.at).toLocaleString()}` : 'Never'}</dd>
          <dt>Notes</dt><dd>${esc(person.notes || '—')}</dd>
        </dl>
      </div>`;
    modal.hidden = false;
    document.body.classList.add('ov-modal-open');

    document.getElementById('faceResyncBtn')?.addEventListener('click', async () => {
      const res = await fetch(sessionUrl(`/api/face/persons/${person.id}/resync`), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Re-sync failed'); return; }
      showToast(`Re-synced — ${data.embeddingCount} embedding(s) on board`);
      await reload();
      openPersonModal(data.person);
    });
  }

  function closeModal() {
    const modal = document.getElementById('facePersonModal');
    if (modal) modal.hidden = true;
    document.body.classList.remove('ov-modal-open');
  }

  function closeClusterModal() {
    const modal = document.getElementById('faceClusterModal');
    if (modal) modal.hidden = true;
    clusterDetailId = null;
    document.body.classList.remove('ov-modal-open');
  }

  async function openClusterModal(clusterId) {
    const modal = document.getElementById('faceClusterModal');
    const body = document.getElementById('faceClusterModalBody');
    if (!modal || !body) return;
    clusterDetailId = clusterId;
    let c = clusters.find((x) => x.id === clusterId);
    try {
      const res = await fetch(sessionUrl(`/api/face/clusters/${encodeURIComponent(clusterId)}`));
      if (res.ok) c = await res.json();
    } catch { /* use cached */ }
    if (!c) {
      showToast('Cluster not found', 'error');
      return;
    }
    const crops = c.crops || [];
    body.innerHTML = `
      <h2>Unknown face group</h2>
      <p class="ov-merged-sub">Seen ${c.seen_count || 0} times · ${(c.cameras || []).join(', ') || '—'} · Last ${formatRelativeTime(c.last_seen_at)}</p>
      <div class="ov-face-cluster-gallery">
        ${crops.length ? crops.map((crop) => `
          <figure>
            <img src="${cropUrl(crop.filename || crop.id, c.id)}" alt="" loading="lazy">
            <figcaption>${esc(crop.camera_name || crop.camera_id || '')} · ${esc(formatRelativeTime(crop.seen_at))}</figcaption>
          </figure>`).join('') : '<p class="ov-det-empty">No photos yet</p>'}
      </div>
      <form class="ov-face-cluster-nameform ov-face-cluster-nameform--modal" data-cluster-label="${esc(c.id)}">
        <input class="ov-det-input" name="name" type="text" placeholder="Give this person a name" required autocomplete="off">
        <select class="ov-det-select" name="groupId">
          ${groups.map((g) => `<option value="${g.id}" ${g.id === 'visitors' ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
        <button type="submit" class="ov-cam-add-btn">Save & recognize</button>
      </form>`;
    modal.hidden = false;
    document.body.classList.add('ov-modal-open');
    body.querySelector('[data-cluster-label]')?.addEventListener('submit', onClusterLabelSubmit);
  }

  async function onClusterLabelSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const id = form.getAttribute('data-cluster-label');
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) { showToast('Enter a name', 'error'); return; }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const cluster = clusters.find((c) => c.id === id);
    try {
      const res = await fetch(sessionUrl(`/api/face/clusters/${encodeURIComponent(id)}/label`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          groupId: fd.get('groupId') || 'visitors',
          previewCrop: cluster?.preview_crop || cluster?.crops?.[0]?.filename || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Could not save name', 'error');
        return;
      }
      showToast(`✓ ${name} saved — now recognizable`, 'success');
      closeClusterModal();
      await reload();
      activeTab = 'database';
      renderShell();
    } catch (err) {
      showToast(err.message || 'Save failed', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save name'; }
    }
  }

  function bindClusterEvents() {
    document.getElementById('faceClustersRefreshBtn')?.addEventListener('click', async () => {
      await loadClusters();
      renderShell();
    });

    const thresh = document.getElementById('faceClusterThresh');
    const threshVal = document.getElementById('faceClusterThreshVal');
    thresh?.addEventListener('input', () => {
      if (threshVal) threshVal.textContent = Number(thresh.value).toFixed(2);
    });
    thresh?.addEventListener('change', async () => {
      const value = Number(thresh.value);
      try {
        const res = await fetch(sessionUrl('/api/face/clusters/config/threshold'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold: value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error || 'Could not update sensitivity', 'error');
          return;
        }
        clusterThreshold = data.threshold ?? value;
        showToast('Match sensitivity updated');
      } catch (err) {
        showToast(err.message || 'Update failed', 'error');
      }
    });

    document.querySelectorAll('[data-cluster-label]').forEach((form) => {
      form.addEventListener('submit', onClusterLabelSubmit);
    });

    document.querySelectorAll('[data-action="open-cluster"]').forEach((btn) => {
      btn.addEventListener('click', () => openClusterModal(btn.dataset.id));
    });

    document.querySelectorAll('[data-action="discard-cluster"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Discard this unknown face group?')) return;
        const res = await fetch(sessionUrl(`/api/face/clusters/${encodeURIComponent(btn.dataset.id)}`), {
          method: 'DELETE',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.error || 'Discard failed', 'error');
          return;
        }
        showToast('Cluster discarded');
        await loadClusters();
        renderShell();
      });
    });

    document.querySelectorAll('[data-close-cluster-modal]').forEach((el) => {
      el.addEventListener('click', closeClusterModal);
    });
  }

  function bindEvents() {
    document.querySelectorAll('[data-face-tab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        activeTab = btn.dataset.faceTab;
        if (activeTab === 'clusters') {
          await refreshClustersIfNeeded(true);
        }
        renderShell();
      });
    });

    bindClusterEvents();

    document.getElementById('faceDbSearch')?.addEventListener('input', (e) => {
      dbSearch = e.target.value;
      dbPage = 1;
      loadPersons().then(renderShell);
    });
    document.getElementById('faceDbGroupFilter')?.addEventListener('change', (e) => {
      dbGroupFilter = e.target.value;
      dbPage = 1;
      renderShell();
    });
    document.getElementById('faceDbSort')?.addEventListener('change', (e) => {
      dbSort = e.target.value;
      renderShell();
    });
    document.getElementById('faceDbPrev')?.addEventListener('click', () => { dbPage -= 1; renderShell(); });
    document.getElementById('faceDbNext')?.addEventListener('click', () => { dbPage += 1; renderShell(); });

    document.getElementById('faceAddPersonBtn')?.addEventListener('click', () => {
      activeTab = 'enrollment';
      renderShell();
    });

    document.querySelectorAll('[data-select-person]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.selectPerson;
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        renderShell();
      });
    });

    document.getElementById('faceBulkDeleteBtn')?.addEventListener('click', async () => {
      if (!selectedIds.size || !confirm(`Delete ${selectedIds.size} person(s)?`)) return;
      await fetch(sessionUrl('/api/face/persons/bulk-delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      selectedIds.clear();
      showToast('Persons deleted');
      await reload();
    });

    document.querySelectorAll('[data-action="view-person"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await fetch(sessionUrl(`/api/face/persons/${btn.dataset.id}`));
        const data = await res.json();
        if (data.person) openPersonModal(data.person);
      });
    });

    document.querySelectorAll('[data-action="delete-person"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this person?')) return;
        await fetch(sessionUrl(`/api/face/persons/${btn.dataset.id}`), { method: 'DELETE' });
        showToast('Person deleted');
        await reload();
      });
    });

    document.querySelectorAll('[data-action="save-board-name"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const input = document.querySelector(`[data-board-rename="${id}"]`);
        const name = input?.value?.trim();
        if (!name) { showToast('Enter a name', 'error'); return; }
        const res = await fetch(sessionUrl(`/api/face/board/persons/${encodeURIComponent(id)}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (res.ok) {
          const result = await res.json().catch(() => ({}));
          showToast(result.merged
            ? `Merged into existing ${result.name} identity`
            : 'Identity name saved on board');
          await loadBoardPersons();
          renderShell();
        } else {
          const err = await res.json().catch(() => ({}));
          showToast(err.error || 'Rename failed', 'error');
        }
      });
    });

    document.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));

    document.getElementById('faceManualForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type="submit"]');
      const fullName = String(fd.get('fullName') || '').trim();
      if (!fullName) { showToast('Full name is required', 'error'); return; }
      const imageFile = fd.get('image');
      let enrollImage = null;
      if (imageFile?.size) enrollImage = await readFileAsBase64(imageFile);
      if (!enrollImage) {
        showToast('Select a profile image to enroll the face', 'error');
        return;
      }
      const ok = await submitEnroll({
        fullName,
        personId: fd.get('personId'),
        groupId: fd.get('groupId'),
        role: fd.get('role'),
        department: fd.get('department'),
        notes: fd.get('notes'),
        authorizationStatus: fd.get('authorizationStatus'),
        contact: { email: fd.get('email'), phone: fd.get('phone') },
        enrollImage,
        profileImage: enrollImage,
      }, btn);
      if (ok) { e.target.reset(); await reload(); }
    });

    document.getElementById('faceSingleUploadForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type="submit"]');
      const fullName = String(fd.get('fullName') || '').trim();
      if (!fullName) { showToast('Full name is required', 'error'); return; }
      const image = await readFileAsBase64(fd.get('image'));
      const ok = await submitEnroll({
        fullName,
        groupId: fd.get('groupId'),
        enrollImage: image,
        profileImage: image,
        authorizationStatus: 'pending',
      }, btn);
      if (ok) { e.target.reset(); await reload(); }
    });

    document.getElementById('faceBulkForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const files = [...(fd.getAll('images') || [])];
      const items = [];
      for (const file of files) {
        const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
        items.push({ fullName: name, groupId: fd.get('groupId'), image: await readFileAsBase64(file) });
      }
      const res = await fetch(sessionUrl('/api/face/persons/bulk-enroll'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      showToast(`Bulk enrolled ${data.imported || 0} of ${items.length}`);
      if (data.results?.some((r) => !r.ok)) {
        const fail = data.results.find((r) => !r.ok);
        if (fail?.error) showToast(`${fail.fullName}: ${fail.error}`);
      }
      e.target.reset();
      await reload();
    });

    document.getElementById('faceImportForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const file = fd.get('file');
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch(sessionUrl('/api/face/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
      const data = await res.json();
      showToast(`Imported ${data.imported || 0} persons`);
      e.target.reset();
      await reload();
    });

    document.getElementById('faceCaptureBtn')?.addEventListener('click', () => {
      const video = document.querySelector('#fliveStreamHost video');
      const canvas = document.createElement('canvas');
      if (!video || !video.videoWidth) {
        showToast('Start a camera live view first');
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      capturedImage = canvas.toDataURL('image/jpeg', 0.92);
      const prev = document.getElementById('faceCapturePreview');
      if (prev) prev.innerHTML = `<img src="${capturedImage}" alt="Capture">`;
      const btn = document.getElementById('faceCaptureEnrollBtn');
      if (btn) btn.disabled = false;
      showToast('Frame captured');
    });

    document.getElementById('faceCaptureForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!capturedImage) { showToast('Capture a frame first'); return; }
      const fd = new FormData(e.target);
      const existingId = fd.get('existingId');
      if (existingId) {
        const res = await fetch(sessionUrl(`/api/face/persons/${existingId}/enroll`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: capturedImage }),
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Enroll failed', 'error'); return; }
        showEnrollBanner('success', 'Face added', `${data.person?.fullName || 'Person'} now has ${data.embeddingCount || 1} embedding(s)`);
        showToast('Face added to person', 'success');
        activeTab = 'database';
      } else {
        const btn = document.getElementById('faceCaptureEnrollBtn');
        const ok = await submitEnroll({
          fullName: String(fd.get('fullName') || '').trim(),
          groupId: fd.get('groupId'),
          enrollImage: capturedImage,
          profileImage: capturedImage,
        }, btn);
        if (!ok) return;
      }
      capturedImage = null;
      e.target.reset();
      await reload();
    });

    document.querySelectorAll('[data-action="ack-alert"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(sessionUrl(`/api/face/alerts/${btn.dataset.id}/acknowledge`), { method: 'POST' });
        showToast('Alert acknowledged');
        await loadAlerts();
        renderShell();
      });
    });

    document.getElementById('faceAckAllBtn')?.addEventListener('click', async () => {
      const active = alerts.filter((a) => a.status === 'active').map((a) => a.id);
      if (!active.length) return;
      await fetch(sessionUrl('/api/face/alerts/bulk-acknowledge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: active }),
      });
      showToast('All alerts acknowledged');
      await loadAlerts();
      renderShell();
    });
  }

  function connectWs() {
    if (dashWs) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sid = sessionStorage.getItem('atomoSessionId');
    const qs = sid ? `&sessionId=${encodeURIComponent(sid)}` : '';
    try {
      dashWs = new WebSocket(`${proto}//${location.host}/ws/detection?slug=face${qs}`);
      dashWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'face_update') {
            if (msg.payload) dashboard = { ...(dashboard || {}), ...msg.payload, faceMetrics: msg.payload.faceMetrics };
            if (msg.faceDatabase) dashboard = { ...dashboard, ...msg.faceDatabase };
            // Keep "Recognition activity" live: the broadcast payload carries the
            // latest events, and newEvents carries freshly emitted ones. Without
            // this, only alerts refreshed and the events timeline stayed stale.
            const payloadEvents = Array.isArray(msg.payload?.events) ? msg.payload.events : null;
            if (payloadEvents) {
              dashboard = { ...(dashboard || {}), recentEvents: payloadEvents };
            } else if (msg.newEvents?.length) {
              const existing = new Set((dashboard?.recentEvents || []).map((e) => e.id));
              dashboard = {
                ...(dashboard || {}),
                recentEvents: [
                  ...msg.newEvents.filter((e) => !existing.has(e.id)),
                  ...(dashboard?.recentEvents || []),
                ].slice(0, 20),
              };
            }
            if (msg.newEvents?.length && window.DetectionTab?.prependEvents) {
              window.DetectionTab.prependEvents(msg.newEvents, msg.payload);
            }
            if (activeTab === 'clusters') {
              refreshClustersIfNeeded(false).then((changed) => {
                // Avoid wiping an in-progress name field unless groups actually changed.
                if (changed) renderShell();
              });
            } else if (activeTab === 'overview' || activeTab === 'alerts') {
              renderShell();
            }
          }
        } catch { /* ignore */ }
      };
      dashWs.onclose = () => { dashWs = null; setTimeout(connectWs, 5000); };
    } catch { /* ignore */ }
  }

  window.FaceModule = {
    reload,
    openTab(tab) {
      if (tab) activeTab = tab;
      const go = async () => {
        if (activeTab === 'clusters') await refreshClustersIfNeeded(true);
        renderShell();
        document.getElementById('faceModuleRoot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      go();
    },
    onNewEvents() {
      if (activeTab === 'overview') loadDashboard().then(() => renderShell());
    },
    init() {
      const root = document.getElementById('faceModuleRoot');
      if (!root) return;
      reload();
      connectWs();
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    window.FaceModule?.init();
  });
})();
