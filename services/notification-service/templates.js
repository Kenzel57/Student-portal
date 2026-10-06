// Turns a domain event into an email: { to, subject, text, html } or null
// when there's no one to send it to.

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function wrapHtml(heading, paragraphs) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1c2430;max-width:520px">
  <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2>
  ${paragraphs.map((p) => `<p style="margin:0 0 10px">${escapeHtml(p)}</p>`).join("\n  ")}
  <p style="margin:16px 0 0"><a href="${escapeHtml(PORTAL_URL)}" style="color:#1f5fbf">Open the Student Portal</a></p>
  <p style="margin:16px 0 0;font-size:12px;color:#6b7482">Automated message from the Student Portal. Please don't reply.</p>
</div>`;
}

// grade.posted -> the student. The grade itself is deliberately left out of
// the email (email isn't a secure channel); the student logs in to see it.
function gradePosted(event) {
  const course = event.courseTitle ? `${event.courseCode} (${event.courseTitle})` : event.courseCode;
  const lines = [
    `A new grade has been posted for ${course}, ${event.semester}.`,
    "Log in to the Student Portal to view it in your transcript.",
  ];
  return {
    to: event.studentEmail || null,
    subject: `New grade posted: ${event.courseCode}`,
    text: `Hello${event.studentName ? " " + event.studentName : ""},\n\n${lines.join("\n")}\n\n${PORTAL_URL}\n`,
    html: wrapHtml(`Hello${event.studentName ? " " + event.studentName : ""},`, lines),
  };
}

// pastpaper.uploaded -> DEADLINE SIMPLIFICATION: sent to the uploader as a
// confirmation, not to every student enrolled in the course. Enrolments are
// currently programme-level (no per-course enrolment exists until the
// Course & Enrolment stretch service), so there is no reliable course
// roster to fan out to yet.
function pastPaperUploaded(event) {
  const tags = event.tags && event.tags.length ? ` (tags: ${event.tags.join(", ")})` : "";
  const lines = [
    `A new past paper has been uploaded: ${event.course}, ${event.year}, ${event.semester}${tags}.`,
    "It is now available to download from the Past Papers section of the Student Portal.",
  ];
  return {
    to: event.uploaderEmail || null,
    subject: `New past paper: ${event.course} ${event.year} ${event.semester}`,
    text: `Hello,\n\n${lines.join("\n")}\n\n${PORTAL_URL}\n`,
    html: wrapHtml("Hello,", lines),
  };
}

const TEMPLATES = { "grade.posted": gradePosted, "pastpaper.uploaded": pastPaperUploaded };

module.exports = { TEMPLATES, escapeHtml };
