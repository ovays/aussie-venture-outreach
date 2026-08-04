# Initial outreach prompt redesign

## Audit: old prompt versus new prompt

The old writer had no system prompt. Its user prompt prescribed four parts in a
fixed order, selected one of three near-identical introductions, pinned one of
four sentence shapes, supplied a connector verbatim, and required an exact CTA.
Representative instructions were:

```text
WRITE FOUR PARTS, IN THIS ORDER, AND NOTHING ELSE
Use this sentence, either as written or with very small wording changes
Use this shape, and no other
If that shape needs a connector, use "...". Do not substitute a different one.
Use exactly this line, on its own line, and nothing else
```

Several supplied connectors were the phrases showing up repeatedly in sent
copy, including variations of “thought I’d ask”, “which is why I’m emailing”,
and “yours came up”. Each AI request is isolated, so the model had no memory of
earlier emails and repeatedly converged on the same permitted skeleton.

The new writer separates stable voice rules from per-lead facts:

```text
SYSTEM
You are Owais, a Sydney content creator who personally runs Aussie Venture.
Sound like one person who chose to email this business.
Use only supplied facts.
Personalise with no more than one meaningful research detail.
Make the structure feel chosen for this recipient.
Write 70 to 120 words with exactly one collaboration question.

USER
RECIPIENT FACTS
RESEARCH DECISION
TRUE SENDER FACTS
ASSIGNMENT FOR THIS RECIPIENT
```

Every lead receives a deterministic but non-templated structural direction and
paragraph rhythm. Research is optional, suburb/category filler is rejected, and
the provider must perform its review silently and return one JSON object.

## Twenty illustrative emails

These examples use the same facts as the repeatable preview script. The standard
sign-off is shown in the first sample and is identical on the other nineteen.

### 1. Halal restaurant

**Subject:** Aussie Venture x Cedar & Coal

Hey Cedar & Coal,

The custom open-fire grill is what made me want to email. Charcoal cooking gives
the food a clear story without needing a long explanation.

I’m Owais, and I run Aussie Venture. We share food, activities and travel from
around Australia with roughly 650k followers across Instagram, TikTok and
Facebook. I’d be keen to feature Cedar & Coal in a way that feels true to the
place.

Would you be interested in collaborating?

Cheers,
Owais
Aussie Venture
aussieventure.com
instagram.com/aussie.venture

### 2. Cafe

**Subject:** Working together?

Hey Cornerstone Coffee Lab,

I’d like to explore a feature around the coffee you roast on site. The roasting
process gives the story a useful focus beyond another cafe recommendation.

I’m Owais from Aussie Venture. We post food, activities and travel from around
Australia for roughly 650k followers across Instagram, TikTok and Facebook. I
keep the page personal, and Cornerstone feels worth a direct note.

Any interest in working together?

### 3. Patisserie

**Subject:** Collab with Aussie Venture?

Hey Honeycomb Patisserie,

Watching pastries being finished from the dining room is a lovely detail. It
gives people a reason to pay attention to the craft, not only the final plate.

I run Aussie Venture, where we share food, activities and travel from around
Australia with about 650k followers across Instagram, TikTok and Facebook. I’m
Owais, and I’d like to feature what Honeycomb does in that open kitchen.

Would this be something you’d be open to?

### 4. Waterfront hotel

**Subject:** Collab?

Hey The Quay House,

A hotel inside a converted finger wharf has a story built into it. That was the
detail that made The Quay House worth a personal email.

I’m Owais. I run Aussie Venture, a Sydney page sharing food, activities and
travel from around Australia with around 650k followers on Instagram, TikTok and
Facebook. I’d like to explore a feature centred on the character of the place,
without overcomplicating the idea here.

Would you be interested in working together?

### 5. Regional retreat

**Subject:** Collab?

Hey Paperbark Retreat,

The idea of sleeping among the paperbark trees is a strong starting point for a
feature. It says something specific about the stay without needing a list of
facilities.

I run Aussie Venture, an Australian food, activities and travel page with around
650k followers across Instagram, TikTok and Facebook. I’m Owais, based in
Sydney, and Paperbark Retreat is somewhere I’d like to include on the page.

Is a collaboration something you’d consider?

### 6. Escape room

**Subject:** Collab with Aussie Venture?

Hey Cipher Rooms,

Four story-led rooms running at once gives Cipher Rooms more depth than a single
challenge. I can see a clear feature in how those different stories sit under
one roof.

I’m Owais from Aussie Venture. We share food, activities and travel around
Australia with roughly 650k followers across Instagram, TikTok and Facebook. I
wanted to keep this first note simple and ask about the idea directly.

Would you be open to collaborating?

### 7. Go karting

**Subject:** Collab with Aussie Venture?

Hey Volt Raceway,

I’m keen to feature Volt Raceway. The two-level electric track gives the place a
distinct angle and a natural focus for the story.

My name’s Owais and I run Aussie Venture, a Sydney page covering food,
activities and travel around Australia. We have about 650k followers across
Instagram, TikTok and Facebook. Rather than send a long pitch, I wanted to see
whether the collaboration itself interests you first.

Would you be up for working together?

### 8. Bowling

**Subject:** Collab?

Hey Tenpin Social,

Late-night bowling changes the feel of the usual daytime session, and that’s the
part I’d be interested in featuring.

I’m Owais. Aussie Venture is the page I run across Instagram, TikTok and
Facebook, sharing food, activities and travel from around Australia with about
650k followers. Tenpin Social feels like it has enough personality to carry a
short feature without dressing it up as something it isn’t.

Any interest in a collab?

### 9. Mini golf

**Subject:** Collab?

Hey Puttworks,

An indoor course built around Sydney landmarks is a clever concept. I’d like to
explore featuring that idea on Aussie Venture.

I’m Owais, and I run the page personally. We post food, activities and travel
from around Australia for around 650k followers across Instagram, TikTok and
Facebook. The landmark theme gives each hole its own small story, which is a
much more interesting reason to write than sending a generic venue pitch.

Would you be interested in working together?

### 10. Arcade

**Subject:** Collab?

Hey Replay Arcade,

The mix of restored 1980s cabinets and current rhythm games caught my attention.
It gives Replay Arcade a nice contrast between nostalgia and what people play
now.

I run Aussie Venture, a page about food, activities and travel from around
Australia. I’m Owais, and we’ve built roughly 650k followers across Instagram,
TikTok and Facebook. I’d be keen to make Replay Arcade one of the places we
feature.

Would a collaboration be of interest?

### 11. Climbing gym

**Subject:** Working together?

Hey Summit Yard,

I’d like to feature Summit Yard on Aussie Venture. Having bouldering and
full-height rope walls in the same gym gives the story more range than focusing
on one style of climbing.

I’m Owais, the person behind the page. We share food, activities and travel from
around Australia with about 650k followers across Instagram, TikTok and
Facebook. I’m based in Sydney and prefer to ask about the idea plainly before
getting into any detail.

Would you be open to working together?

### 12. VR experience

**Subject:** Collab?

Hey Free Roam VR,

A group moving together through a warehouse-scale wireless arena is a compelling
idea in its own right. That shared movement is what I’d want a feature to focus
on.

I’m Owais from Aussie Venture. We post food, activities and travel from around
Australia for roughly 650k followers across Instagram, TikTok and Facebook. I’d
like to explore including Free Roam VR on the page and see whether the interest
is mutual.

Would you be interested in collaborating?

### 13. Trampoline park

**Subject:** Quick one about a collab

Hey Airborne,

The dedicated ninja course gives me a much clearer reason to feature Airborne
than a general trampoline session. It adds a skill element and a story people
can follow.

I run Aussie Venture, sharing food, activities and travel around Australia with
about 650k followers across Instagram, TikTok and Facebook. I’m Owais, based in
Sydney, and I’d like to ask about a feature without turning the first email into
a full proposal.

Would you be open to a collab?

### 14. Harbour cruise

**Subject:** Collab?

Hey Harbour After Dark,

Timing a small-group cruise around sunset and the harbour lights gives the
experience a clear point of view. That’s what interested me about a possible
feature.

I’m Owais and I run Aussie Venture, a Sydney page with around 650k followers
across Instagram, TikTok and Facebook. We share food, activities and travel from
around Australia, and I think Harbour After Dark could sit naturally within what
I post.

Would you be interested in working together?

### 15. Cultural tour

**Subject:** Aussie Venture x Saltwater Stories

Hey Saltwater Stories,

I’m interested in featuring the coastal walks led by Aboriginal educators. The
knowledge carried through the walk gives it substance, and that deserves a
careful, straightforward approach.

I run Aussie Venture, where we share food, activities and travel around Australia
with roughly 650k followers across Instagram, TikTok and Facebook. I’m Owais,
based in Sydney, and I’d like to see whether Saltwater Stories would consider a
feature with the page.

Would you be open to collaborating?

### 16. Bathhouse

**Subject:** Working together?

Hey Still House Bathing,

The communal hot-and-cold bathing concept is what made me curious about a
feature. It has a clear identity without needing me to make broad claims about
the whole experience.

I’m Owais from Aussie Venture. We post food, activities and travel from around
Australia to about 650k followers across Instagram, TikTok and Facebook. I run
the page personally from Sydney and would be keen to include Still House in a
future feature.

Is that something you’d be interested in?

### 17. Nail studio

**Subject:** Quick one about a collab

Hey Studio Gloss,

The hand-painted nail work is a craft detail I’d like to build a feature around.
It’s specific, visual and says more than simply calling Studio Gloss a nail
salon.

I’m Owais, and I run Aussie Venture. We share food, activities and travel from
around Australia with about 650k followers across Instagram, TikTok and
Facebook. I’d like to explore including Studio Gloss on the page, with the
painted detail as the focus rather than a broad salon feature.

Any interest in working together?

### 18. Curly-hair salon

**Subject:** Quick one about a collab

Hey Curl Assembly,

I’d like to explore a feature about your focus on naturally curly hair. A clear
speciality gives the story a useful centre without turning the email into a list
of salon services.

I run Aussie Venture, an Australian food, activities and travel page with around
650k followers across Instagram, TikTok and Facebook. I’m Owais, based in
Sydney, and wanted to ask about the collaboration itself before discussing
anything beyond that.

Would this be something you’d consider?

### 19. Cooking class

**Subject:** Collab with Aussie Venture?

Hey The Dumpling Bench,

Teaching people to fold dumplings by hand gives the class a simple, human story.
That practical detail is what made me interested in featuring it.

I’m Owais from Aussie Venture. We post food, activities and travel from around
Australia with about 650k followers across Instagram, TikTok and Facebook. I’d
be keen to include The Dumpling Bench on the page and keep the first conversation
as straightforward as this email.

Would you be interested in collaborating?

### 20. Sparse research case

**Subject:** Quick one about a collab

Hey Northside Fun Centre,

I’m Owais, and I run Aussie Venture, a page sharing food, activities and travel
from around Australia. We have roughly 650k followers across Instagram, TikTok
and Facebook.

A feature with Northside Fun Centre is something I’d be keen to explore. I don’t
want to guess at what would suit you or bury the idea in a long pitch, so I’d
rather start with a simple question and take it from there if the interest is
mutual.

Would you be open to a collaboration?

## What varies across the examples

- The business detail, collaboration intent or Owais introduction can lead.
- Introductions appear as one sentence, two sentences or a later paragraph.
- Research is paraphrased once and omitted when it is weak.
- Paragraph rhythms vary without fixed sentence templates.
- The suburb and raw category appear only when they add genuine context.
- Every email ends with one uncomplicated question.
