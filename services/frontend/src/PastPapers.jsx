import { useCallback, useEffect, useRef, useState } from "react";
import { listPapers, searchPapers, uploadPaper, downloadPaper, SessionExpiredError } from "./api.js";

// Fixed choices keep semester values consistent, so the exact-match filter works.
const SEMESTERS = ["Semester 1", "Semester 2", "Resit"];
const EMPTY_SEARCH = { q: "", year: "", semester: "", tag: "" };

const formatSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export default function PastPapers({ canUpload, onSessionExpired }) {
  const [criteria, setCriteria] = useState(EMPTY_SEARCH);
  const [results, setResults] = useState(null); // { papers, label }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const handleError = useCallback((err) => {
    if (err instanceof SessionExpiredError) return onSessionExpired(err.message);
    setError(err.message);
  }, [onSessionExpired]);

  const showAll = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const data = await listPapers();
      setResults({ papers: data.papers, label: `All past papers (${data.total})` });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    showAll();
  }, [showAll]);

  async function handleSearch(event) {
    event.preventDefault();
    if (Object.values(criteria).every((v) => !v.trim())) return showAll();
    setError("");
    setLoading(true);
    try {
      const data = await searchPapers(criteria);
      setResults({ papers: data.papers, label: `${data.count} result${data.count === 1 ? "" : "s"}` });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setCriteria(EMPTY_SEARCH);
    showAll();
  }

  async function handleDownload(paper) {
    setError("");
    setBusyId(paper.id);
    try {
      await downloadPaper(paper.id);
      // Mirror the server-side increment without refetching the list.
      setResults((r) => ({
        ...r,
        papers: r.papers.map((p) => (p.id === paper.id ? { ...p, downloadCount: p.downloadCount + 1 } : p)),
      }));
    } catch (err) {
      handleError(err);
    } finally {
      setBusyId(null);
    }
  }

  const set = (field) => (e) => setCriteria((c) => ({ ...c, [field]: e.target.value }));

  return (
    <>
      <div className="title-row">
        <h1>Past Papers</h1>
      </div>

      <section className="card">
        <form className="search-bar" onSubmit={handleSearch}>
          <input className="grow" placeholder="Search course code, tag… e.g. swe midterm" value={criteria.q} onChange={set("q")} />
          <input type="number" placeholder="Year" min="1990" max="2100" value={criteria.year} onChange={set("year")} />
          <select value={criteria.semester} onChange={set("semester")}>
            <option value="">Any semester</option>
            {SEMESTERS.map((s) => <option key={s}>{s}</option>)}
          </select>
          <input placeholder="Tag" value={criteria.tag} onChange={set("tag")} />
          <button type="submit" disabled={loading}>Search</button>
          <button type="button" className="secondary" onClick={handleClear} disabled={loading}>Show all</button>
        </form>
      </section>

      {canUpload && <UploadForm onUploaded={showAll} onError={handleError} />}

      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>{loading ? "Loading…" : results?.label}</h2>
        {results && results.papers.length === 0 && !loading && <p className="muted">No past papers found.</p>}
        {results && results.papers.length > 0 && (
          <table>
            <thead>
              <tr><th>Course</th><th>Year</th><th>Semester</th><th>Tags</th><th className="num">Downloads</th><th className="num">Size</th><th>Uploaded</th><th /></tr>
            </thead>
            <tbody>
              {results.papers.map((p) => (
                <tr key={p.id}>
                  <td>{p.course}</td>
                  <td>{p.year}</td>
                  <td>{p.semester}</td>
                  <td>{p.tags.map((t) => <span key={t} className="chip">{t}</span>)}</td>
                  <td className="num">{p.downloadCount}</td>
                  <td className="num">{formatSize(p.sizeBytes)}</td>
                  <td>{new Date(p.uploadedAt).toLocaleDateString()}</td>
                  <td>
                    <button className="small-btn" onClick={() => handleDownload(p)} disabled={busyId === p.id}>
                      {busyId === p.id ? "…" : "Download"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function UploadForm({ onUploaded, onError }) {
  const [fields, setFields] = useState({ course: "", year: String(new Date().getFullYear()), semester: SEMESTERS[0], tags: "" });
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const fileInput = useRef(null);

  const set = (field) => (e) => setFields((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");
    const file = fileInput.current.files[0];
    if (!file) return setMessage("Choose a PDF file first.");
    const form = new FormData();
    form.append("file", file);
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    setUploading(true);
    try {
      const { paper } = await uploadPaper(form);
      setMessage(`Uploaded ${paper.course} ${paper.year} (${paper.semester}).`);
      setFields((f) => ({ ...f, course: "", tags: "" }));
      fileInput.current.value = "";
      onUploaded();
    } catch (err) {
      onError(err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="card">
      <h2>Upload a past paper</h2>
      <form className="upload-form" onSubmit={handleSubmit}>
        <label>PDF file <input type="file" accept="application/pdf,.pdf" ref={fileInput} required /></label>
        <label>Course <input placeholder="e.g. SWE301" value={fields.course} onChange={set("course")} required /></label>
        <label>Year <input type="number" min="1990" max="2100" value={fields.year} onChange={set("year")} required /></label>
        <label>Semester
          <select value={fields.semester} onChange={set("semester")}>
            {SEMESTERS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="wide">Tags (comma-separated) <input placeholder="e.g. midterm, architecture" value={fields.tags} onChange={set("tags")} /></label>
        <div className="wide">
          <button type="submit" disabled={uploading}>{uploading ? "Uploading…" : "Upload"}</button>
          {message && <span className="muted small upload-msg">{message}</span>}
        </div>
      </form>
    </section>
  );
}
