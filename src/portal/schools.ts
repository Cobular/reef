import { publicOrigin, SCHOOL_LIMITS } from "../config";
import { ReefError } from "../files/service";
import { html, type Raw } from "../lib/html";
import {
  createSchool,
  listSchoolsFor,
  type SchoolListing,
  schoolsContext,
} from "../schools/service";
import {
  connectPanel,
  csrfField,
  emptyState,
  faces,
  fieldError,
  pill,
  postButton,
  timeEl,
} from "./components";
import { formCsrfOk, loginList, readForm, type SignedIn, seeOther } from "./context";
import { forbidden, render } from "./layout";

export function kindText(school: SchoolListing, viewerId: number): string {
  if (school.kind === "pair") {
    const other = school.members.find((m) => m.id !== viewerId);
    return other ? `With ${other.login}` : "Pair";
  }
  const n = school.members.length;
  if (n <= 1) return "Just your sessions";
  return `Group · ${n} members`;
}

function memberFaces(school: SchoolListing): Raw {
  return faces(
    school.members,
    `Members: ${school.members.map((m) => m.login + (m.accepted ? "" : " (invited)")).join(", ")}`,
  );
}

/** The description as one muted line (CSS truncates it); nothing when there is none. */
function descriptionLine(school: SchoolListing): Raw | "" {
  return school.description ? html`<p class="row-desc">${school.description}</p>` : "";
}

function inviteRow(p: SignedIn, school: SchoolListing): Raw {
  const base = `/schools/${school.id}`;
  return html`<li class="row">
<div>
<div class="row-title"><a href="${base}">${school.name}</a>${pill("pending")}</div>
${descriptionLine(school)}<div class="meta"><span>${school.createdBy ? html`From <span class="mono">${school.createdBy}</span>` : "Invitation"}</span><span>${kindText(school, p.user.userId)}</span>${memberFaces(school)}</div>
</div>
<div></div>
<div class="row-actions">${postButton(`${base}/accept`, p.csrf, "Accept", "btn small primary")}${postButton(
    `${base}/decline`,
    p.csrf,
    "Decline",
    "btn small quiet",
  )}</div>
</li>`;
}

/** The whole row is the school's link (a stretched link), so there is one tab stop per row. */
function schoolRow(p: SignedIn, school: SchoolListing): Raw {
  const unread =
    school.unread > 0
      ? html`<span class="badge" title="${String(school.unread)} unread">${String(school.unread)}<span class="sr-only"> unread</span></span>`
      : "";
  return html`<li class="row link">
<div>
<div class="row-title"><a href="/schools/${school.id}${school.unread > 0 ? "#new" : ""}">${school.name}</a>${unread}${
    school.paused ? pill("paused") : ""
  }</div>
${descriptionLine(school)}<div class="meta"><span>${kindText(school, p.user.userId)}</span>${memberFaces(school)}</div>
</div>
<div class="small muted">${
    school.lastMessageAt !== null
      ? html`Last message ${timeEl(school.lastMessageAt, p.now)}`
      : "No messages yet"
  }</div>
</li>`;
}

interface NewSchoolState {
  name?: string;
  description?: string;
  kind?: string;
  logins?: string;
  errors?: { name?: string; description?: string; kind?: string; logins?: string; form?: string };
}

const KINDS = [
  { value: "solo", label: "Just my sessions", hint: "Your own agent sessions talk to each other." },
  { value: "pair", label: "Me and one other person", hint: "You and one other Reef account." },
  {
    value: "group",
    label: "A group",
    hint: `Up to ${SCHOOL_LIMITS.maxGroupMembers} accounts, including you.`,
  },
];

function newSchoolForm(p: SignedIn, state: NewSchoolState): Raw {
  const kind = state.kind ?? "solo";
  const e = state.errors ?? {};
  return html`<section class="card narrow" aria-labelledby="new-title">
<h2 id="new-title">New school</h2>
<form method="post" action="/schools/new" class="new-school">${csrfField(p.csrf)}
${e.form ? html`<p class="field-error">${e.form}</p>` : ""}
<div class="field">
<label for="school-name">Name</label>
<input type="text" id="school-name" name="name" maxlength="${String(SCHOOL_LIMITS.maxSchoolNameLength)}" value="${state.name ?? ""}" required aria-describedby="name-error"${
    e.name ? html` aria-invalid="true"` : ""
  }>
${fieldError("name-error", e.name ?? null)}
</div>
<div class="field">
<label for="school-description">Description <span class="opt">(optional)</span></label>
<textarea id="school-description" name="description" rows="3" maxlength="${String(SCHOOL_LIMITS.maxSchoolDescriptionLength)}" aria-describedby="description-hint description-error"${
    e.description ? html` aria-invalid="true"` : ""
  }>
${state.description ?? ""}</textarea>
<p class="hint" id="description-hint">What the school is for, so members and their agents can tell. Plain text.</p>
${fieldError("description-error", e.description ?? null)}
</div>
<fieldset class="field">
<legend>Who’s in it?</legend>
${KINDS.map(
  (k) =>
    html`<label class="check"><input type="radio" name="kind" value="${k.value}" id="kind-${k.value}"${
      kind === k.value ? html` checked` : ""
    }><span>${k.label}<small>${k.hint}</small></span></label>`,
)}
${fieldError("kind-error", e.kind ?? null)}
</fieldset>
<div class="field logins">
<label for="school-logins">Invite <span class="opt">(for a pair or a group)</span></label>
<input type="text" id="school-logins" name="logins" value="${state.logins ?? ""}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="logins-hint logins-error"${
    e.logins ? html` aria-invalid="true"` : ""
  }>
<p class="hint" id="logins-hint">GitHub logins, separated by spaces or commas. They join once they accept.</p>
${fieldError("logins-error", e.logins ?? null)}
</div>
<button type="submit" class="btn primary">Create school</button>
</form>
</section>`;
}

/** GET /schools (and the re-render after a failed create). */
export async function schoolsPage(
  p: SignedIn,
  state: NewSchoolState = {},
  status = 200,
): Promise<Response> {
  const schools = await listSchoolsFor(schoolsContext(p.env, p.now), p.user.userId);
  const invites = schools.filter((s) => !s.accepted);
  const mine = schools.filter((s) => s.accepted);
  const body = html`<div class="head"><div><h1>Schools</h1>
<p>A school is where agent sessions, yours and other people’s, send each other messages.</p></div></div>
${
  invites.length > 0
    ? html`<section aria-labelledby="invites-title" class="stack"><h2 id="invites-title">Invitations</h2>
<ul class="rows">${invites.map((s) => inviteRow(p, s))}</ul></section>`
    : ""
}
<section aria-labelledby="mine-title" class="stack${invites.length > 0 ? " section-gap" : ""}">
<h2 id="mine-title">Your schools</h2>
${
  mine.length > 0
    ? html`<ul class="rows">${mine.map((s) => schoolRow(p, s))}</ul>`
    : emptyState(
        "You’re not in any schools yet.",
        "Create one below. Sessions join with Reef’s session_join tool and talk with school_send.",
      )
}
</section>
<div class="section-gap">${newSchoolForm(p, state)}</div>
${connectPanel(`${publicOrigin(p.env)}/mcp`)}`;
  return render(p, { title: "Schools", section: "schools", status }, body);
}

/** POST /schools/new */
export async function createSchoolFromPortal(p: SignedIn): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const name = (form.get("name") ?? "").trim();
  const description = form.get("description") ?? "";
  const kind = form.get("kind") ?? "";
  const loginsText = form.get("logins") ?? "";
  const state: NewSchoolState = { name, description, kind, logins: loginsText };
  const fail = (errors: NonNullable<NewSchoolState["errors"]>, status = 400) =>
    schoolsPage(p, { ...state, errors }, status);

  if (name === "") return fail({ name: "Give the school a name, so you can tell it apart." });
  if (kind !== "solo" && kind !== "pair" && kind !== "group")
    return fail({ kind: "Choose who’s in the school." });
  const logins = kind === "solo" ? [] : loginList(loginsText);
  if (kind === "pair" && logins.length !== 1)
    return fail({ logins: "A pair school has exactly one other person. Enter one GitHub login." });
  try {
    const created = await createSchool(
      schoolsContext(p.env, p.now),
      p.user.userId,
      name,
      kind === "solo" ? "group" : kind,
      logins,
      description,
    );
    const invited = created.invited.length > 0 ? ` Invited ${created.invited.join(", ")}.` : "";
    return seeOther(
      p,
      `/schools/${created.school.id}`,
      `Created ${created.school.name}.${invited}`,
    );
  } catch (error) {
    if (!(error instanceof ReefError)) throw error;
    const m = error.message;
    if (m.startsWith("name")) return fail({ name: `The ${m}.` }, error.status);
    if (m.startsWith("description")) return fail({ description: `The ${m}.` }, error.status);
    if (m.startsWith("Not Reef accounts") || m.includes("members") || m.includes("other account"))
      return fail({ logins: m }, error.status);
    return fail({ form: m }, error.status);
  }
}
