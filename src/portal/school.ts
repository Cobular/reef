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
  markSeenInPortal,
  pauseSchool,
  resumeSchool,
  type SchoolListing,
  schoolsContext,
  sendPortalMessage,
  setSessionTypes,
  transcript,
  updateSchoolDetails,
} from "../schools/service";
import {
  avatar,
  confirmForm,
  csrfField,
  faces,
  fieldError,
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

/** How a transcript page links to messages and offers replies. */
interface MessageLinks {
  base: string;
  /** The oldest seq on this page; a replied-to message older than it is on an earlier page. */
  oldestSeq: number;
  /** Offer a Reply link (not while the school is paused). */
  canReply: boolean;
  /** The session's form token, for the attachments' one-click Download buttons. */
  csrf: string;
}

/** A link to message `seq`: an in-page anchor, or the earlier page that ends with it. */
function messageHref(seq: number, links: MessageLinks): string {
  return seq >= links.oldestSeq
    ? `#m${String(seq)}`
    : `${links.base}?before=${String(seq + 1)}#m${String(seq)}`;
}

function replyRef(r: NonNullable<MessageView["replyTo"]>, links: MessageLinks): Raw {
  const ref = `#${String(r.seq)}`;
  return r.parent
    ? html`<p class="msg-reply"><a href="${messageHref(r.seq, links)}"><span aria-hidden="true">↩ </span><span class="sr-only">In reply to </span>${ref} · <span class="mono">${r.parent.sender.login}</span></a></p>`
    : html`<p class="msg-reply"><span aria-hidden="true">↩ </span><span class="sr-only">In reply to </span>${ref} · no longer available</p>`;
}

function message(m: MessageView, now: number, links: MessageLinks): Raw {
  const other = m.origin === "other_account";
  const classes = `msg${other ? " other" : ""}${m.person ? " person" : ""}`;
  const seq = String(m.seq);
  return html`<li class="${classes}" id="m${seq}">
${avatar(m.sender)}
<div>
<div class="msg-head"><strong>${m.sender.login}</strong>${
    m.person
      ? html`<span class="chip">${icons.person}In the portal</span>`
      : html`<span class="msg-via">${[m.label, m.product].filter((x) => x).join(" · ")}</span>${sessionChip(
          m.sessionType as SessionType,
        )}`
  }<span class="msg-when">${timeEl(m.createdAt, now)}${
    links.canReply
      ? html`<a class="reply-link" href="${links.base}?reply=${seq}#compose">Reply<span class="sr-only"> to #${seq}</span></a>`
      : ""
  }</span></div>
${m.replyTo ? replyRef(m.replyTo, links) : ""}<p class="msg-text">${m.text}</p>
${
  m.attachments.length > 0
    ? html`<ul class="attach" aria-label="Attachments">${m.attachments.map((a) =>
        a.gone
          ? html`<li><span class="file-chip gone">${icons.file}<span>${a.name ?? "A file"} · file has swum off</span></span></li>`
          : html`<li><a class="file-chip" href="/files/${a.fileId}">${icons.file}<span class="mono">${a.name ?? a.fileId}</span></a>${
              a.key
                ? html`<form method="post" action="/files/${a.fileId}/download">${csrfField(links.csrf)}<input type="hidden" name="key" value="${a.key}"><button type="submit" class="btn small quiet">Download<span class="sr-only"> ${a.name ?? a.fileId}</span></button></form>`
                : ""
            }</li>`,
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
${school.description ? html`<p class="school-desc">${school.description}</p>` : ""}
<p>${
      school.createdBy
        ? html`<span class="mono">${school.createdBy}</span> invited you to this school.`
        : "You’re invited to this school."
    } ${school.kind === "pair" ? "Just the two of you." : `${String(school.members.length)} members, including you.`}</p>
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

/** What the details form shows after a refused update. */
export interface DetailsState {
  name: string;
  description: string;
  errors: { name?: string; description?: string; form?: string };
  status: number;
}

/** What the compose form shows after a refused send. */
export interface ComposeState {
  text: string;
  error: string;
  status: number;
  /** The seq the refused send replied to, so the reply survives the re-render. */
  replyTo?: number;
}

/** The reply the compose form is set up for: the seq asked for, and that message if it exists. */
interface ComposeReply {
  seq: number;
  target: MessageView | null;
}

function replyChip(reply: ComposeReply, links: MessageLinks): Raw {
  const seq = String(reply.seq);
  if (!reply.target)
    return html`<p class="hint" id="compose-reply">Message #${seq} is no longer in this school, so this won’t be sent as a reply. <a href="${links.base}#compose">Dismiss</a></p>`;
  return html`<div class="reply-chip" id="compose-reply"><span>Replying to <a href="${messageHref(
    reply.seq,
    links,
  )}">#${seq}</a> · <span class="mono">${reply.target.sender.login}</span></span><a href="${links.base}#compose">Cancel<span class="sr-only"> reply</span></a></div>
<input type="hidden" name="reply_to" value="${seq}">`;
}

function composeForm(
  p: SignedIn,
  school: SchoolListing,
  compose: ComposeState | undefined,
  reply: ComposeReply | null,
  links: MessageLinks,
): Raw {
  if (school.paused)
    return html`<div class="compose" id="compose"><p class="small muted">Sending is off while the school is paused. Any member can resume it.</p>${
      compose ? html`<p class="field-error" role="alert">${compose.error}</p>` : ""
    }</div>`;
  const max = String(SCHOOL_LIMITS.maxMessageBytes);
  return html`<form class="compose" id="compose" method="post" action="/schools/${school.id}/send">${csrfField(p.csrf)}
<label for="compose-text">Write to the school</label>
${reply ? replyChip(reply, links) : ""}
<textarea id="compose-text" name="text" rows="3" maxlength="${max}" required data-max-bytes="${max}" data-count="compose-count" aria-describedby="${
    reply ? "compose-reply " : ""
  }compose-hint compose-error"${compose ? html` aria-invalid="true"` : ""}${
    compose || reply ? html` autofocus` : ""
  }>
${compose?.text ?? ""}</textarea>
${fieldError("compose-error", compose?.error ?? null)}
<div class="compose-foot">
<p class="hint" id="compose-hint">Agents see this as from you, in the portal. <span class="count" id="compose-count" hidden></span></p>
<button type="submit" class="btn primary">Send</button>
</div>
</form>`;
}

function detailsCard(p: SignedIn, school: SchoolListing, details: DetailsState | undefined): Raw {
  const e = details?.errors ?? {};
  return html`<section class="card" aria-label="Name and description"><details class="edit"${details ? html` open` : ""}><summary>Edit name and description</summary>
<form method="post" action="/schools/${school.id}/details">${csrfField(p.csrf)}
${e.form ? html`<p class="field-error">${e.form}</p>` : ""}
<div class="field">
<label for="school-name">Name</label>
<input type="text" id="school-name" name="name" value="${
    details ? details.name : school.name
  }" maxlength="${String(SCHOOL_LIMITS.maxSchoolNameLength)}" required autocomplete="off" aria-describedby="name-error"${
    e.name ? html` aria-invalid="true"` : ""
  }>
${fieldError("name-error", e.name ?? null)}
</div>
<div class="field">
<label for="school-description">Description <span class="opt">(optional)</span></label>
<textarea id="school-description" name="description" rows="4" maxlength="${String(
    SCHOOL_LIMITS.maxSchoolDescriptionLength,
  )}" aria-describedby="description-hint description-error"${
    e.description ? html` aria-invalid="true"` : ""
  }>
${details ? details.description : school.description}</textarea>
<p class="hint" id="description-hint">What the school is for. Members’ agents see it too. Plain text.</p>
${fieldError("description-error", e.description ?? null)}
</div>
<button type="submit" class="btn small">Save</button>
</form>
</details>
</section>`;
}

function sidePanel(p: SignedIn, school: SchoolListing, details?: DetailsState): Raw {
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
${detailsCard(p, school, details)}
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
<label for="invite-logins" class="sr-only">GitHub logins or display names to invite</label>
<div class="inline-form"><div><input type="text" id="invite-logins" name="logins" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="invite-hint">
<p class="hint" id="invite-hint">GitHub logins or Reef display names, separated by spaces or commas.</p></div>
<button type="submit" class="btn">Invite</button></div>
</form></section>`
    : ""
}
<section class="card" aria-labelledby="pause-title"><h2 id="pause-title">${school.paused ? "Paused" : "Pause"}</h2>
<p class="small muted">${
    school.paused
      ? "No one, person or session, can send messages here until a member resumes the school."
      : "Stops every member, and their sessions, from sending here, until a member resumes it."
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

/** GET /schools/:id (and the re-render after a refused details update or send). */
export async function schoolPage(
  p: SignedIn,
  id: string,
  details?: DetailsState,
  compose?: ComposeState,
): Promise<Response> {
  const school = await findSchool(p, id);
  if (!school) return noSchool(p);
  if (!school.accepted) return inviteView(p, school);
  const beforeText = p.url.searchParams.get("before");
  const before = beforeText && /^\d{1,15}$/.test(beforeText) ? Number(beforeText) : undefined;
  // A Reply link sets ?reply=<seq>; a refused send keeps the seq it replied to.
  const replyText = p.url.searchParams.get("reply");
  const replySeq =
    before !== undefined
      ? undefined
      : (compose?.replyTo ??
        (replyText && /^[1-9]\d{0,14}$/.test(replyText) ? Number(replyText) : undefined));
  const page = await transcript(schoolsContext(p.env, p.now), p.user.userId, id, {
    ...(before !== undefined ? { before } : {}),
    ...(replySeq !== undefined ? { replyTo: replySeq } : {}),
  });
  const messages = [...page.messages].reverse();
  const base = `/schools/${school.id}`;
  const links: MessageLinks = {
    base,
    oldestSeq: messages[0]?.seq ?? 0,
    canReply: !school.paused,
    csrf: p.csrf,
  };
  const reply = replySeq !== undefined ? { seq: replySeq, target: page.replyTarget } : null;
  // The divider sits before the first message this person hasn't seen in the portal, skipping
  // what they wrote there. If that is the first message on a page with earlier
  // ones, the boundary is further back, so skip it.
  const firstNew = messages.findIndex(
    (m) => m.seq > school.readSeq && !(m.person && m.sender.id === p.user.userId),
  );
  const divider = firstNew > 0 || (firstNew === 0 && page.nextBefore === null) ? firstNew : -1;
  // Viewing the newest page marks it seen for this person (not for their sessions), so the
  // Schools badge clears. The divider above still uses the position from before this view.
  const newest = messages[messages.length - 1];
  if (before === undefined && newest && newest.seq > school.readSeq)
    await markSeenInPortal(schoolsContext(p.env, p.now), p.user.userId, school.id, newest.seq);
  const body = html`<p class="small"><a href="/schools">← Schools</a></p>
${
  school.paused
    ? html`<div class="banner" role="status"><strong>School’s out.</strong><p>Nobody can send messages, from a session or here, until a member resumes it.</p></div>`
    : ""
}
<div class="title-row"><h1>${school.name}</h1>${school.paused ? pill("paused") : ""}<span class="muted">${kindText(
    school,
    p.user.userId,
  )}</span>${faces(school.members, `Members: ${school.members.map((m) => m.login).join(", ")}`)}</div>
${school.description ? html`<p class="school-desc">${school.description}</p>` : ""}
<div class="split">
<section class="card transcript" aria-labelledby="transcript-title">
<h2 id="transcript-title" class="sr-only">Messages</h2>
${
  page.nextBefore !== null
    ? html`<div class="pager"><a class="btn small" href="${base}?before=${String(page.nextBefore)}">Show earlier messages</a></div>`
    : ""
}
${
  messages.length > 0
    ? html`<ol class="msgs">${messages.map((m, i) =>
        i === divider
          ? html`<li class="divider" id="new">New<span class="sr-only"> messages start here</span></li>${message(m, p.now, links)}`
          : message(m, p.now, links),
      )}</ol>`
    : html`<div class="empty"><p class="lead">No messages${before !== undefined ? " before these" : " yet"}.</p>
<p class="muted">Agent sessions post here with Reef’s <code>school_send</code> tool, and members can write here too.</p></div>`
}
${
  before !== undefined
    ? html`<div class="pager"><a class="btn small quiet" href="${base}">Show the latest messages</a></div>`
    : composeForm(p, school, compose, reply, links)
}
</section>
${sidePanel(p, school, details)}
</div>`;
  return render(
    p,
    {
      title: school.name,
      section: "schools",
      status: details?.status ?? compose?.status ?? 200,
    },
    body,
  );
}

export type SchoolAction =
  | "accept"
  | "decline"
  | "leave"
  | "types"
  | "pause"
  | "resume"
  | "invite"
  | "details"
  | "send";

export const SCHOOL_ACTIONS: readonly SchoolAction[] = [
  "accept",
  "decline",
  "leave",
  "types",
  "pause",
  "resume",
  "invite",
  "details",
  "send",
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
  if (action === "details") return detailsFromPortal(p, school, form);
  if (action === "send") return sendFromPortal(p, school, form);
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
        note = `Paused ${school.name}. No one can send messages here until a member resumes it.`;
        break;
      case "resume":
        await resumeSchool(ctx, actor, school.id);
        note = `Resumed ${school.name}. Messages can be sent again.`;
        break;
      case "invite": {
        const logins = loginList(form.get("logins"));
        if (logins.length === 0) {
          note = "Type at least one GitHub login or display name to invite.";
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

/** POST /schools/:id/details. A refused field re-renders the page with the error by it. */
async function detailsFromPortal(
  p: SignedIn,
  school: SchoolListing,
  form: URLSearchParams,
): Promise<Response> {
  const here = `/schools/${school.id}`;
  const name = form.get("name") ?? "";
  const description = form.get("description");
  try {
    const saved = await updateSchoolDetails(
      schoolsContext(p.env, p.now),
      p.user.userId,
      school.id,
      description === null ? { name } : { name, description },
    );
    const notes: string[] = [];
    if (saved.nameChanged) notes.push(`Renamed to ${saved.name}.`);
    if (saved.descriptionChanged)
      notes.push(saved.description ? "Updated the description." : "Removed the description.");
    if (notes.length === 0) return seeOther(p, here, "Nothing to change.", "info");
    return seeOther(p, here, notes.join(" "));
  } catch (error) {
    if (!(error instanceof ReefError)) throw error;
    if (error.status === 400 && school.accepted) {
      const m = error.message;
      const field = m.startsWith("description")
        ? "description"
        : m.startsWith("name")
          ? "name"
          : "form";
      return schoolPage(p, school.id, {
        name,
        description: description ?? school.description,
        errors: { [field]: field === "form" ? m : `The ${m}.` },
        status: error.status,
      });
    }
    return seeOther(p, here, error.message, "error");
  }
}

/** POST /schools/:id/send. A refused send re-renders the page with the text kept. */
async function sendFromPortal(
  p: SignedIn,
  school: SchoolListing,
  form: URLSearchParams,
): Promise<Response> {
  const here = `/schools/${school.id}`;
  const text = form.get("text") ?? "";
  // A malformed reply_to becomes NaN, which the service refuses with a clear message.
  const replyText = (form.get("reply_to") ?? "").trim();
  const replyTo =
    replyText === "" ? undefined : /^\d{1,15}$/.test(replyText) ? Number(replyText) : Number.NaN;
  try {
    const { seq } = await sendPortalMessage(
      schoolsContext(p.env, p.now),
      p.user.userId,
      school.id,
      text,
      replyTo,
    );
    return seeOther(p, `${here}#m${String(seq)}`, "Sent.");
  } catch (error) {
    if (!(error instanceof ReefError)) throw error;
    if (!school.accepted) return seeOther(p, here, error.message, "error");
    return schoolPage(p, school.id, undefined, {
      text,
      error: error.message,
      status: error.status,
      ...(replyTo !== undefined && replyTo >= 1 ? { replyTo } : {}),
    });
  }
}
