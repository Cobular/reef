import type { GitHubApi } from "../auth/github";
import { logout, startLogin } from "../auth/portal";
import { redirect, safeNext, text } from "../lib/http";
import { logError } from "../lib/log";
import { ADMIN_ACTIONS, type AdminAction, adminAction, adminPage } from "./admin";
import { serveAsset, serveFaviconIco } from "./assets";
import { formCsrfOk, type Portal, portalContext, readForm, type SignedIn } from "./context";
import { deleteFromPortal, downloadFromPortal, filePage, shareFromPortal } from "./file";
import { filesPage } from "./files";
import { landingPage } from "./landing";
import { errorScreen, forbidden, notFound } from "./layout";
import { SCHOOL_ACTIONS, type SchoolAction, schoolAction, schoolPage } from "./school";
import { createSchoolFromPortal, schoolsPage } from "./schools";
import { createBrowserUpload, uploadPage } from "./upload";

const ID = "([a-z0-9]{1,64})";
const FILE = new RegExp(`^/files/${ID}$`);
const FILE_ACTION = new RegExp(`^/files/${ID}/(download|share|delete)$`);
const SCHOOL = new RegExp(`^/schools/${ID}$`);
const SCHOOL_ACTION = new RegExp(`^/schools/${ID}/([a-z]+)$`);
const ADMIN_ACTION = /^\/admin\/([a-z]+\/[a-z]+)$/;

/** Pages that need a session; anything else under these prefixes is still a 404 for them. */
const SIGNED_IN_ONLY = /^\/(files|schools|admin)(\/|$)/;

/**
 * Every people-facing route: the landing page, files, schools, admin, sign-in and sign-out,
 * and the static assets. OAuth, MCP and the data API are routed before this.
 */
export async function handlePortal(
  request: Request,
  env: Env,
  github: GitHubApi,
  partSize: number,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/static/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Use GET.");
    return serveAsset(url.pathname) ?? text(404, "Not found.");
  }
  if (url.pathname === "/favicon.ico") {
    if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Use GET.");
    return serveFaviconIco();
  }
  // HEAD answers like GET (uptime monitors use it), with the same status and headers, no body.
  if (request.method === "HEAD") {
    const response = await handlePortal(
      new Request(request, { method: "GET" }),
      env,
      github,
      partSize,
    );
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const p = await portalContext(request, env, partSize);
  try {
    return await route(p, github);
  } catch (error) {
    logError("portal.failed", error, { path: url.pathname, method: request.method });
    return errorScreen(
      p,
      500,
      "Something went wrong",
      "Reef hit a problem on its side and nothing was changed. Try again in a moment.",
    );
  }
}

async function route(p: Portal, github: GitHubApi): Promise<Response> {
  const { method } = p.request;
  const path = p.url.pathname;

  if (path === "/") {
    if (method !== "GET") return notFound(p);
    return p.user ? redirect("/files") : landingPage(p);
  }
  if (path === "/login" && method === "GET") {
    const next = safeNext(p.url.searchParams.get("next"));
    if (p.user) return redirect(next ?? "/files");
    return startLogin(p.env, github, next);
  }
  if (path === "/logout" && method === "POST") {
    // Signed out already: nothing to protect, just clear the cookie.
    if (p.user && p.csrf && !formCsrfOk(p as SignedIn, await readForm(p.request)))
      return forbidden(p);
    return logout();
  }
  if (path === "/portal" && method === "GET") return redirect("/files");

  if (!SIGNED_IN_ONLY.test(path)) return notFound(p);
  if (!p.user || !p.csrf) return signInFirst(p);
  return signedIn(p as SignedIn);
}

/** Where a signed-out visitor goes: sign in, then come back to the page (not to a POST). */
function signInFirst(p: Portal): Response {
  const path = p.url.pathname;
  if (p.request.method === "POST" && path === "/files/new" && wantsJson(p.request))
    return Response.json(
      { error: { field: "form", message: "Your session ended. Sign in again, then retry." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  let back = path + p.url.search;
  if (p.request.method !== "GET") {
    const page = /^\/(files|schools)\/([a-z0-9]{1,64})\/[a-z]+$/.exec(path);
    back = page ? `/${page[1]}/${page[2]}` : (`/${path.split("/")[1] ?? "files"}` as string);
  }
  return redirect(`/login?next=${encodeURIComponent(back)}`, {}, 303);
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("application/json");
}

async function signedIn(p: SignedIn): Promise<Response> {
  const { method } = p.request;
  const path = p.url.pathname;
  const get = method === "GET";
  const post = method === "POST";
  const file = get ? FILE.exec(path) : null;
  const fileAction = post ? FILE_ACTION.exec(path) : null;
  const school = get ? SCHOOL.exec(path) : null;
  const schoolPost = post ? SCHOOL_ACTION.exec(path) : null;
  const adminPost = post ? ADMIN_ACTION.exec(path) : null;

  if (path === "/files" && get) return filesPage(p);
  if (path === "/files/new") {
    if (get) return uploadPage(p);
    if (post) return createBrowserUpload(p);
  }
  if (file) return filePage(p, file[1] as string);
  if (fileAction) {
    const id = fileAction[1] as string;
    if (fileAction[2] === "download") return downloadFromPortal(p, id);
    if (fileAction[2] === "share") return shareFromPortal(p, id);
    return deleteFromPortal(p, id);
  }

  if (path === "/schools" && get) return schoolsPage(p);
  if (path === "/schools/new" && post) return createSchoolFromPortal(p);
  if (school) return schoolPage(p, school[1] as string);
  if (schoolPost) {
    const action = schoolPost[2] as SchoolAction;
    if (SCHOOL_ACTIONS.includes(action)) return schoolAction(p, schoolPost[1] as string, action);
  }

  // Not admins get the same 404 as any unknown page.
  if (p.admin) {
    if (path === "/admin" && get) return adminPage(p);
    const action = adminPost?.[1] as AdminAction | undefined;
    if (action && ADMIN_ACTIONS.includes(action)) return adminAction(p, action);
  }
  return notFound(p);
}
