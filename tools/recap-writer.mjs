// tools/recap-writer.mjs — builds the prompt and calls Claude to generate the
// understated title + plain, factual opener for the Strava/YouTube recap
// workflow. Extracted verbatim (prompt text unchanged) from what used to be
// an inline heredoc in .github/workflows/strava-youtube-comment.yml — see
// AGENTS.md.
export function buildRecapPrompt({ detail, mi, timeStr, ft, videoTitle, segments, roadNames, riderNotes }) {
  const promptLines = [
    'Write a title and an opening line for a Strava cycling activity.',
    '',
    'Style rules (apply to both):',
    '- Plain and factual. State what the route was — roads, terrain, landmarks — the way you\'d describe it to a friend, not narrate a feeling.',
    '- Never invent a specific fact that isn\'t actually present in the data below or the rider\'s own notes — a destination, a method of travel, a name, a plan, a reason. If the rider\'s notes are vague on something ("headed home tomorrow"), stay equally vague rather than filling in a specific-sounding detail. A plausible guess that happens to be wrong is worse than a vaguer sentence that\'s true.',
    '- The segment list below is Strava-defined ride efforts, ranked by rider popularity — NOT a list of road names. Only state one as the name of a road if it plausibly reads like one (e.g. "Moose-Wilson Rd"). Otherwise treat it as a landmark/feature reference, or leave it out rather than implying it was the road surface you rode on.',
    '- The "Roads ridden" list, if present, IS real road names (matched from GPS) — these you can state directly and confidently as the roads you were on, listed in the actual order they were ridden. Never reorder them or imply a different sequence than given.',
    '- The road list is just an ORDER, not a shape — you don\'t know if the ride was a loop, an out-and-back, or point-to-point, only which road came after which. Never describe a route shape ("looped back on X", "circled around", "returned via X", "back down Y") — that asserts a geometric relationship between roads that isn\'t in the data. Just state the roads in the order given (e.g. "rode X, then Y, then Z") without claiming how they relate to each other spatially.',
    '- You do NOT need to mention every road in the list. If the rider left notes, THEIR words and what they actually cared about are the priority — pick one or two roads that anchor the ride, don\'t spend the whole opener enumerating all of them at the expense of the rider\'s own voice.',
    '- Never mention PRs, achievements, speed, or performance — no bragging.',
    '- No calls to action, no hashtags, no emoji, no quotation marks.',
    '- If the opener is two sentences, each sentence must add NEW information — a different place, feature, or detail. Never restate or rephrase the same landmark, road segment, or feature in both sentences.',
    '- BANNED: metaphor, personification (light/gravel/road "doing" something), rhetorical questions, invented internal feelings or unexplainable moments ("something I couldn\'t explain"), any line that sounds like the opening of a blog post or travel essay.',
    '- The opener should quietly make the reader curious enough to watch the ride video linked below it, without ever asking them to, and without overselling it.',
    '',
    'Title: a short activity title (roughly 3-7 words). Good example: "Morning Miles Under the Tetons".',
    'Opener: one or two short sentences for the top of the activity description. Good example (plain, factual, no metaphor, each clause adds something new): "Morning spin up Moose–Wilson Road and through the park to Jenny Lake — quiet roads, two stretches of gravel, and the Tetons out in full the whole way."',
    'Bad example 1 (too flowery — do not write like this): "The gravel stretch north of the fee station has a way of pulling your eyes off the road and toward the ridgeline. Somewhere between Jenny Lake and the Moose entrance the morning light did something I couldn\'t quite explain."',
    'Bad example 2 (repeats the same detail across both sentences — do not write like this): "Rode Moose-Wilson Road north from the fee station, including the gravel section, then up to Jenny Lake and back down toward the Moose entrance. The gravel stretch north of the fee station is on the video below."',
    'Bad example 3 (invents specifics the rider never said — do not write like this): rider\'s note says "headed home tomorrow" (no city, no method) -> "before the drive back to Chicago tomorrow." Write "before heading home tomorrow" instead — true to what was actually said.',
    'Bad example 4 (invents a route shape from the road order alone — do not write like this): roads list is "Teton Village Road; Moose-Wilson Road; West Highway 22; Spring Gulch Road" -> "out along Teton Village Road, then looped back on Moose-Wilson Road and West Highway 22." Write "rode Teton Village Road, Moose-Wilson Road, West Highway 22, and Spring Gulch Road" instead — the order is real, the "looped back" shape is not.',
    '',
    'Ride data:',
    `- Current activity name: ${detail.name}`,
    `- Start (local): ${detail.start_date_local}`,
    `- Distance: ${mi} mi · Moving time: ${timeStr} · Elevation gain: ${ft} ft`,
    `- Video title: ${videoTitle}`,
    `- Popular segments ridden (most riders first): ${segments.join('; ') || 'n/a'}`,
  ];
  if (roadNames.length) {
    promptLines.push(`- Roads ridden, in the order ridden: ${roadNames.join('; ')}`);
  }
  if (riderNotes) {
    promptLines.push(
      '',
      'The rider recorded these notes right after finishing (their own words, voice-to-text, may be informal or fragmented). These notes are the PRIMARY source for the opener — lead with what the rider actually said (including how they felt about the ride, plans, anything notable that happened), and use the road/segment data above as supporting detail woven in where it fits naturally, not as a checklist to complete. Don\'t let a full recitation of roads crowd out the rider\'s own words. Keep following every style rule above (plain/factual, no metaphor, no personification, no repetition, no invented specifics):',
      `"""${riderNotes}"""`
    );
  }
  return promptLines.join('\n');
}

// Calls Claude to generate { title, opener }. Returns:
//   { ok: true, title?, opener? }  — call succeeded (title/opener are only
//     present if Claude returned them within the length caps we enforce)
//   { ok: false, error }           — non-2xx response or a refusal
// Throws only on a hard failure (network error, unparseable response) — the
// caller (.github/workflows/strava-youtube-comment.yml) wraps the call in a
// try/catch and falls back to the existing title / video title, same as
// before extraction.
//
// apiBase/fetchImpl are test seams (default to the real Anthropic API host)
// — do not document them in README.md's operator-facing env var tables, per
// AGENTS.md's existing TWITCH_HELIX_BASE/STRIPE_API_BASE note.
export async function generateRecap({ prompt, apiKey, apiBase = "https://api.anthropic.com", fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              opener: { type: 'string' },
            },
            required: ['title', 'opener'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.stop_reason === 'refusal') {
    return { ok: false, error: data.error || data.stop_reason };
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const parsed = JSON.parse(text);
  const result = { ok: true };
  if (parsed.title && parsed.title.length <= 100) result.title = parsed.title.trim();
  if (parsed.opener && parsed.opener.length <= 400) result.opener = parsed.opener.trim();
  return result;
}
