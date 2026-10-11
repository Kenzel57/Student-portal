// All backend communication and token handling lives here.
//
// Access token: memory only (gone on reload, never readable from storage).
// Refresh token: sessionStorage, so a page reload keeps you logged in; it is
// cleared when the tab closes. Post-deadline hardening: move it to an
// httpOnly cookie set by the Auth Service so JavaScript can't read it at all.

const REFRESH_KEY = "portal.refreshToken";
let accessToken = null;
let refreshInFlight = null;

export class SessionExpiredError extends Error {}

function storeTokens(data) {
  accessToken = data.accessToken;
  try {
    sessionStorage.setItem(REFRESH_KEY, data.refreshToken);
  } catch {
    // storage unavailable (private mode): session just won't survive a reload
  }
}

function clearTokens() {
  accessToken = null;
  try {
    sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    // ignore
  }
}

function storedRefreshToken() {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, data };
}

// Returns the logged-in user ({ id, email, role, institutionId }).
export async function login(email, password) {
  const { res, data } = await postJson("/auth/login", { email, password });
  if (!res.ok) throw new Error(data?.error || `Login failed (HTTP ${res.status})`);
  storeTokens(data);
  return data.user;
}

// Refresh tokens are single-use, so concurrent callers share one refresh.
function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = storedRefreshToken();
      if (!refreshToken) return null;
      const { res, data } = await postJson("/auth/refresh", { refreshToken });
      if (!res.ok) {
        clearTokens();
        return null;
      }
      storeTokens(data);
      return data.user;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Called on page load: turns a stored refresh token back into a session.
export function restoreSession() {
  return refresh();
}

export async function logout() {
  const refreshToken = storedRefreshToken();
  clearTokens();
  if (refreshToken) await postJson("/auth/logout", { refreshToken }).catch(() => {});
}

// fetch() with the access token attached; on 401, refreshes once and retries.
async function authFetch(path, options = {}) {
  const send = () =>
    fetch(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${accessToken}` } });
  let res = await send();
  if (res.status === 401) {
    if (!(await refresh())) throw new SessionExpiredError("Your session has expired. Please log in again.");
    res = await send();
  }
  return res;
}

async function errorFrom(res, fallback) {
  const data = await res.json().catch(() => null);
  return new Error(data?.error || `${fallback} (HTTP ${res.status})`);
}

// Grades grouped by semester with semester and cumulative GPA.
export const getTranscript = (studentId) => getJson(`/transcript/${studentId}`, "Transcript failed to load");

// A plain <a href> can't send the Bearer token, so fetch the file with it and
// hand the browser a temporary object URL to download, named by the server.
async function downloadFile(path, fallbackName) {
  const res = await authFetch(path);
  if (!res.ok) throw await errorFrom(res, "Download failed");
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const downloadTranscriptPdf = (studentId) =>
  downloadFile(`/transcript/${studentId}/pdf`, "transcript.pdf");

// ── Past papers ────────────────────────────────────────────────

async function getJson(path, fallback) {
  const res = await authFetch(path);
  if (!res.ok) throw await errorFrom(res, fallback);
  return res.json();
}

export const listPapers = () => getJson("/pastpapers/list?limit=200", "Past papers failed to load");

// Only non-empty criteria are sent.
export function searchPapers(criteria) {
  const params = new URLSearchParams(
    Object.entries(criteria).filter(([, v]) => String(v ?? "").trim() !== "")
  );
  return getJson(`/pastpapers/search?${params}`, "Search failed");
}

// formData: file, course, year, semester, tags. The browser sets the
// multipart Content-Type (with its boundary) itself, so it isn't set here.
export async function uploadPaper(formData) {
  const res = await authFetch("/pastpapers/upload", { method: "POST", body: formData });
  if (!res.ok) throw await errorFrom(res, "Upload failed");
  return res.json();
}

export const downloadPaper = (id) => downloadFile(`/pastpapers/${id}/download`, "past-paper.pdf");

// Returns { payload, cache } where cache is the X-Cache header (HIT/MISS).
export async function getDashboard() {
  const res = await authFetch("/dashboard/home");
  if (!res.ok) throw await errorFrom(res, "Dashboard failed to load");
  return { payload: await res.json(), cache: res.headers.get("X-Cache") };
}
