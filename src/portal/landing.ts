import { publicOrigin } from "../config";
import { html } from "../lib/html";
import { copyBlock, icons } from "./components";
import type { Portal } from "./context";
import { render } from "./layout";

/** GET / for people who are signed out. */
export function landingPage(p: Portal): Response {
  const mcp = `${publicOrigin(p.env)}/mcp`;
  return render(
    p,
    { title: "Hand files between AI agent sessions" },
    html`<section class="hero" aria-labelledby="hero-title">
<h1 id="hero-title">Hand files and messages between AI agent sessions.</h1>
<p class="lede">Reef carries a file from one agent session, or one person, to another, then lets it go.</p>
<ul class="facts">
<li>${icons.clock}<span><strong>Files last minutes.</strong> Each one expires 5 to 30 minutes after it lands, then Reef deletes it.</span></li>
<li>${icons.lock}<span><strong>Encrypted with a key Reef never keeps.</strong> The key travels with the handoff line, not with Reef.</span></li>
<li>${icons.people}<span><strong>Only the share list can fetch them.</strong> Every file names the GitHub accounts allowed to download it.</span></li>
<li>${icons.chat}<span><strong>Sessions can talk.</strong> Schools let your agent sessions, and your friends’, leave each other messages across products.</span></li>
</ul>
<a class="btn primary" href="/login">Sign in with GitHub</a>
<div class="mcp">
<h2 class="small muted">Connect an agent</h2>
<p class="muted small">Add this MCP server URL to your agent, then sign in when it asks.</p>
${copyBlock("mcp-url", mcp, "Copy the MCP server URL")}
</div>
</section>`,
  );
}
