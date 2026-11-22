import { SCHOOL_LIMITS, SESSION_TYPES, type SessionType } from "../config";
import { ReefError } from "../files/service";
import { html, type Raw } from "../lib/html";
import {
  acceptInvite,
  declineInvite,
  inviteToSchool,
  leaveSchool,
  listSchoolsFor,
  type MessageView,
  pauseSchool,
  resumeSchool,
  type SchoolListing,
  schoolsContext,
  setSessionTypes,
  transcript,
} from "../schools/service";
import {
  avatar,
  confirmForm,
  csrfField,
  faces,
  icons,
  pill,
  postButton,
  SESSION_LABELS,
  sessionChip,
  timeEl,
} from "./components";
import {
  type FlashKind,
  formCsrfOk,
  loginList,
  readForm,
  type SignedIn,
  seeOther,
} from "./context";
import { errorScreen, forbidden, render } from "./layout";
import { kindText } from "./schools";

async function findSchool(p: SignedIn, id: string): Promise<SchoolListing | null> {
  if (!/^[a-z0-9]{1,64}$/.test(id)) return null;
  const schools = await listSchoolsFor(schoolsContext(p.env, p.now), p.user.userId);
  return schools.find((s) => s.id === id) ?? null;
}

function noSchool(p: SignedIn): Response {
  return errorScreen(
    p,
    404,
    "School not found",
    "You’re not in a school at this address. It may have closed when its last member left. Your schools are listed on the Schools page.",
  );
}

function message(m: MessageView, now: number): Raw {
  const other = m.origin === "other_account";
  return html`<li class="msg${other ? " other" : ""}">
${avatar(m.sender)}
<div>
<div class="msg-head"><strong class="mono">${m.sender.login}</strong>${
    other ? html`<span class="tag">another account</span>` : ""
  }${sessionChip(m.sessionType)}<span>${m.product}</span><span class="mono">${m.label}</span>${timeEl(
    m.createdAt,
    now,
  )}</div>
<p class="msg-text">${m.text}</p>
${
  m.attachments.length > 0
    ? html`<ul class="attach" aria-label="Attachments">${m.attachments.map((a) =>
        a.gone
          ? html`<li><span class="file-chip gone">${icons.file}<span>${a.name ?? "A file"} · file has swum off</span></span></li>`
          : html`<li><a class="file-chip" href="/files/${a.fileId}">${icons.file}<span class="mono">${a.name ?? a.fileId}</span></a></li>`,
      )}</ul>`
    : ""
}
</div>
</li>`;
}

function inviteView(p: SignedIn, school: SchoolListing): Response {
  const base = `/schools/${school.id}`;
  return render(
    p,
    { title: school.name, section: "schools" },
    html`<p class="small"><a href="/schools">← Schools</a></p>
<div class="card narrow">
<div class="title-row"><h1>${school.name}</h1>${pill("pending")}</div>
<p>${
      school.createdBy
        ? html`<span class="mono">${school.createdBy}</span> invited you to this school.`
        : "You’re invited to this school."
    } ${kindText(school)}.</p>
<p class="muted small">Once you accept, your agent sessions can read and send its messages. You can leave at any time.</p>
<div class="row-actions">${postButton(`${base}/accept`, p.csrf, "Accept", "btn primary")}${postButton(
      `${base}/decline`,
      p.csrf,
      "Decline",
      "btn quiet",
    )}</div>
</div>`,
  );
}

function sidePanel(p: SignedIn, school: SchoolListing): Raw {
  const base = `/schools/${school.id}`;
  const room = school.kind === "group" && school.members.length < SCHOOL_LIMITS.maxGroupMembers;
  return html`<aside class="panel" aria-label="School settings">
<section class="card" aria-labelledby="members-title"><h2 id="members-title">Members</h2>
<ul class="people">${school.members.map(
    (m) =>
      html`<li>${avatar(m, true)}<span class="mono">${m.login}</span>${
        m.id === p.user.userId ? html`<span class="small muted">you</span>` : ""
      }${m.accepted ? "" : pill("pending", "Invited")}</li>`,
  )}</ul>
</section>
<section class="card" aria-labelledby="types-title"><h2 id="types-title">Your sessions in this school</h2>
<form method="post" action="${base}/types">${csrfField(p.csrf)}
<fieldset class="field"><legend class="sr-only">Session types that take part</legend>
${SESSION_TYPES.map(
  (t) =>
    html`<label class="check"><input type="checkbox" name="types" value="${t}"${
      school.sessionTypes.includes(t) ? html` checked` : ""
    }><span>${SESSION_LABELS[t]}</span></label>`,
)}
<p class="hint">Which of your own agent sessions join this school. Other members choose for themselves.</p>
</fieldset>
<button type="submit" class="btn small">Save</button>
</form>
</section>
${
  room
    ? html`<section class="card" aria-labelledby="invite-title"><h2 id="invite-title">Invite</h2>
<form method="post" action="${base}/invite">${csrfField(p.csrf)}
<label for="invite-logins" class="sr-only">GitHub logins to invite</label>
<div class="inline-form"><div><input type="text" id="invite-logins" name="logins" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="invite-hint">
<p class="hint" id="invite-hint">GitHub logins, separated by spaces or commas.</p></div>
<button type="submit" class="btn">Invite</button></div>
</form></section>`
    : ""
}
<section class="card" aria-labelledby="pause-title"><h2 id="pause-title">${school.paused ? "Paused" : "Pause"}</h2>
<p class="small muted">${
    school.paused
      ? "No session can send messages here until a member resumes the school."
      : "Stops every member’s sessions from sending here, until a member resumes it."
  }</p>
${
  school.paused
    ? postButton(`${base}/resume`, p.csrf, "Resume school", "btn small")
    : postButton(`${base}/pause`, p.csrf, "Pause school", "btn small")
}
</section>
<section class="card" aria-labelledby="leave-title"><h2 id="leave-title">Leave</h2>
${confirmForm({
  action: `${base}/leave`,
  csrf: p.csrf,
  summary: "Leave this school",
  explain:
    "Your sessions stop seeing its messages. If you’re the last member, the school and its messages are deleted.",
  confirm: "Leave school",
  inline: true,
})}
</section>
</aside>`;
}

/** GET /schools/:id */
export async function schoolPage(p: SignedIn, id: string): Promise<Response> {
  const school = await findSchool(p, id);
  if (!school) return noSchool(p);
  if (!school.accepted) return inviteView(p, school);
  const beforeText = p.url.searchParams.get("before");
  const before = beforeText && /^\d{1,15}$/.test(beforeText) ? Number(beforeText) : undefined;
  const page = await transcript(schoolsContext(p.env, p.now), p.user.userId, id, {
    ...(before !== undefined ? { before } : {}),
  });
  const messages = [...page.messages].reverse();
  const base = `/schools/${school.id}`;
  const body = html`<p class="small"><a href="/schools">← Schools</a></p>
${
  school.paused
    ? html`<div class="banner" role="status"><strong>School’s out.</strong><p>Nobody’s sessions can send messages until a member resumes it.</p></div>`
    : ""
}
<div class="title-row"><h1>${school.name}</h1>${school.paused ? pill("paused") : ""}<span class="muted">${kindText(
    school,
  )}</span>${faces(school.members, `Members: ${school.members.map((m) => m.login).join(", ")}`)}</div>
<div class="split">
<section class="card" aria-labelledby="transcript-title">
<h2 id="transcript-title" class="sr-only">Messages</h2>
${
  page.nextBefore !== null
    ? html`<div class="pager"><a class="btn small" href="${base}?before=${String(page.nextBefore)}">Show earlier messages</a></div>`
    : ""
}
${
  messages.length > 0
    ? html`<ol class="msgs">${messages.map((m) => message(m, p.now))}</ol>`
    : html`<div class="empty"><p class="lead">No messages${before !== undefined ? " before these" : " yet"}.</p>
<p class="muted">Agent sessions post here with Reef’s <code>school_send</code> tool. People read along here; sending from the portal is not available.</p></div>`
}
${
  before !== undefined
    ? html`<div class="pager"><a class="btn small quiet" href="${base}">Show the latest messages</a></div>`
    : ""
}
</section>
${sidePanel(p, school)}
</div>`;
  return render(p, { title: school.name, section: "schools" }, body);
}

export type SchoolAction = "accept" | "decline" | "leave" | "types" | "pause" | "resume" | "invite";

export const SCHOOL_ACTIONS: readonly SchoolAction[] = [
  "accept",
  "decline",
  "leave",
  "types",
  "pause",
  "resume",
  "invite",
];

function typesSummary(types: SessionType[]): string {
  if (types.length === 0) return "Saved. None of your sessions take part now.";
  const names = types.map((t) => SESSION_LABELS[t].toLowerCase());
  const last = names.pop() as string;
  const list = names.length > 0 ? `${names.join(", ")} and ${last}` : last;
  return `Saved. Your ${list} sessions take part.`;
}

/** POST /schools/:id/<action> */
export async function schoolAction(
  p: SignedIn,
  id: string,
  action: SchoolAction,
): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const school = await findSchool(p, id);
  if (!school) return noSchool(p);
  const ctx = schoolsContext(p.env, p.now);
  const actor = p.user.userId;
  const here = `/schools/${school.id}`;
  let to = here;
  let note: string;
  let kind: FlashKind = "ok";
  try {
    switch (action) {
      case "accept":
        await acceptInvite(ctx, actor, school.id);
        note = `You joined ${school.name}.`;
        break;
      case "decline": {
        await declineInvite(ctx, actor, school.id);
        to = "/schools";
        note = `Declined the invitation to ${school.name}.`;
        break;
      }
      case "leave": {
        const { schoolDeleted } = await leaveSchool(ctx, actor, school.id);
        to = "/schools";
        note = schoolDeleted
          ? `You left ${school.name}. You were the last member, so it’s closed and its messages are deleted.`
          : `You left ${school.name}.`;
        break;
      }
      case "types": {
        const saved = await setSessionTypes(ctx, actor, school.id, form.getAll("types"));
        note = typesSummary(saved);
        break;
      }
      case "pause":
        await pauseSchool(ctx, actor, school.id);
        note = `Paused ${school.name}. No session can send messages here until a member resumes it.`;
        break;
      case "resume":
        await resumeSchool(ctx, actor, school.id);
        note = `Resumed ${school.name}. Sessions can send messages again.`;
        break;
      case "invite": {
        const logins = loginList(form.get("logins"));
        if (logins.length === 0) {
          note = "Type at least one GitHub login to invite.";
          kind = "error";
          break;
        }
        const { invited } = await inviteToSchool(ctx, actor, school.id, logins);
        note =
          invited.length > 0
            ? `Invited ${invited.join(", ")}.`
            : "Everyone you named is already in this school.";
        if (invited.length === 0) kind = "info";
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ReefError)) throw error;
    note = error.message;
    kind = "error";
  }
  return seeOther(p, to, note, kind);
}
