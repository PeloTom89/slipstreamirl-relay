#!/usr/bin/env node
// tools/discord-changelog.mjs — turns a merged PR's title/body into a
// friendly, jargon-free explanation for the SlipstreamIRL Discord community
// and posts it as an embed. Invoked directly by node from
// .github/workflows/discord-merge-changelog.yml.
//
// This is a copy of slipstreamirl-app's reference implementation, with one
// deliberate format difference: the Discord embed carries no GitHub link
// (no embed.url, no appended "[Details](...)" line) — see
// buildDiscordPayload() below.
//
// Reads everything from env vars (set by the workflow) rather than argv, so
// it stays a drop-in copy across repos. Never throws past main() — a bad/absent
// secret or a failed Claude call must never turn into a red X on every merge,
// and must never post garbage to the public channel.

const ANTHROPIC_MODEL = "claude-haiku-4-5"; // short 1-3 sentence summaries don't need opus; cheap + fast for a per-merge job. Bump to claude-opus-4-8 (what the relay's recap runner uses) if summary quality ever needs it.
const ANTHROPIC_TIMEOUT_MS = 20_000;
const DISCORD_TIMEOUT_MS = 10_000;
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;

const SYSTEM_PROMPT = `You write short changelog announcements for the SlipstreamIRL Discord community.

Audience: IRL cyclists who stream their rides. They are NOT developers and do not care about engineering process.

Rules:
- Plain, friendly, everyday English. No jargon: never say "refactor", "endpoint", "PR", "pull request", "merge", "runtimeVersion", "commit", "API", "config", or similar engineering terms.
- 1 to 3 sentences, describing what actually changed for someone using the app or watching a stream — what's new, better, or fixed.
- If the change is purely internal/behind-the-scenes plumbing with no effect a rider or viewer would notice, say so honestly and briefly (e.g. "Behind-the-scenes improvements to keep things running smoothly") — never invent a user-facing benefit that isn't there.
- Do not make up features, numbers, or claims that aren't supported by the given title/description.
- Keep the headline under 10 words, no ending punctuation.`;

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function plainTitleFallback(prTitle) {
  // Minimal factual fallback used when Claude is unavailable or returns
  // something unusable: the PR title, lightly cleaned up, never raw error
  // text or an empty message.
  const cleaned = (prTitle || "").replace(/\s+/g, " ").trim();
  return {
    headline: "Update shipped",
    explanation: cleaned
      ? `Here's what just shipped: ${cleaned}.`
      : "A small update just shipped.",
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeForCommunity({ apiKey, title, body }) {
  const userContent = `PR title: ${title || "(no title)"}\n\nPR description:\n${
    body ? body.slice(0, 4000) : "(no description provided)"
  }`;

  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        // Forced tool-use is how we get clean structured
        // { headline, explanation } JSON out of the model instead of parsing
        // prose. Mirrors the shape (a schema'd single-object response) the
        // relay's recap workflow uses for its own Claude call.
        tools: [
          {
            name: "post_changelog",
            description:
              "Publish a friendly, plain-English changelog entry for the SlipstreamIRL Discord community.",
            input_schema: {
              type: "object",
              properties: {
                headline: {
                  type: "string",
                  description: "Short, friendly headline, under 10 words, no jargon.",
                },
                explanation: {
                  type: "string",
                  description:
                    "1-3 sentences in plain English explaining what changed for the community.",
                },
              },
              required: ["headline", "explanation"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "post_changelog" },
      }),
    },
    ANTHROPIC_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`Anthropic API returned ${response.status}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === "tool_use");
  const headline = toolUse?.input?.headline;
  const explanation = toolUse?.input?.explanation;

  if (
    typeof headline !== "string" ||
    typeof explanation !== "string" ||
    !headline.trim() ||
    !explanation.trim()
  ) {
    throw new Error("Anthropic response did not contain a usable headline/explanation");
  }

  return { headline: headline.trim(), explanation: explanation.trim() };
}

export function buildDiscordPayload({ headline, explanation, repoName, author }) {
  // Deliberately no embed.url and no appended "[Details](...)" line — this
  // repo's format intentionally omits the GitHub link (see AGENTS.md/README.md
  // "Discord merge changelog"), unlike the slipstreamirl-app reference this
  // was copied from.
  const embed = {
    title: truncate(headline, DISCORD_TITLE_MAX),
    description: truncate(explanation, DISCORD_DESCRIPTION_MAX),
  };

  const footerParts = [repoName, author ? `by ${author}` : null].filter(Boolean);
  if (footerParts.length > 0) {
    embed.footer = { text: footerParts.join(" · ") };
  }

  return { embeds: [embed] };
}

async function postToDiscord(webhookUrl, payload) {
  const response = await fetchWithTimeout(
    webhookUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    DISCORD_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Discord webhook returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  const {
    DISCORD_WEBHOOK_URL,
    ANTHROPIC_API_KEY,
    PR_TITLE,
    PR_BODY,
    PR_AUTHOR,
    REPO_NAME,
    DISCORD_CHANGELOG_DRY_RUN,
  } = process.env;

  if (!DISCORD_WEBHOOK_URL) {
    console.log("DISCORD_WEBHOOK_URL is not configured — skipping Discord changelog post.");
    return;
  }
  if (!ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not configured — skipping Discord changelog post.");
    return;
  }

  let summary;
  try {
    summary = await summarizeForCommunity({
      apiKey: ANTHROPIC_API_KEY,
      title: PR_TITLE,
      body: PR_BODY,
    });
  } catch (err) {
    console.error(`Claude summary failed, using plain-title fallback: ${err.message}`);
    summary = plainTitleFallback(PR_TITLE);
  }

  const payload = buildDiscordPayload({
    headline: summary.headline,
    explanation: summary.explanation,
    repoName: REPO_NAME,
    author: PR_AUTHOR,
  });

  if (DISCORD_CHANGELOG_DRY_RUN === "1") {
    console.log("DISCORD_CHANGELOG_DRY_RUN=1 — printing payload instead of posting:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  try {
    await postToDiscord(DISCORD_WEBHOOK_URL, payload);
    console.log("Posted changelog to Discord.");
  } catch (err) {
    // Never fail the workflow over a Discord-side hiccup — this posts to a
    // public channel, but a failed post is a silent no-op, not a red X.
    console.error(`Failed to post to Discord: ${err.message}`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    // Belt-and-suspenders: main() already catches its own risky calls, but
    // if something else throws, log and exit 0 rather than failing the job.
    console.error(`discord-changelog.mjs: unexpected error: ${err.message}`);
  });
}
