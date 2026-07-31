# Aussie Venture outreach sequences

Reference copy for the full sequence. These are the standard the generated
emails are held to, not literal templates — the live copy comes from the prompts
in `src/ai/workflows.ts`, the voice rules in `src/lib/email-voice.ts` and the
category wording in `src/lib/category-copy.ts`.

## The design

The sequence has one objective: **replies**. Not persuasion. Five emails, five
different jobs.

| Email | When | Job | Word band |
|---|---|---|---|
| Initial | Day 0 | Start a conversation. Who I am, why I'm emailing you, one question. | ≤ 75 |
| Follow-up 1 | Day 7 | Assume they never saw it. Re-introduce, say what I asked, ask again. | 45–80 |
| Follow-up 2 | Day 14 | One more check-in, made as cheap as possible to answer. | 40–65 |
| Follow-up 3 | Day 21 | Close the loop, so nobody is waiting on anybody. | 40–70 |
| Reactivation | Day 90+ | Re-introduce properly, own the earlier attempt, ask about timing. | 65–100 |

The bands are ceilings with a rough floor, never targets. Every one of them was
lowered once it became clear the floors were doing damage: the model would finish
a good short email, count it against a floor of 70, and pad. What it padded with
was always one of two sentences — why replying is worth their while, or their own
business described back to them — because once the actual content is written,
that's the only material left. Both are banned everywhere else in the voice
rules, so the floors were quietly reintroducing them. Coming in under a band is
now explicitly fine (`LENGTH_RULE` in `src/lib/email-voice.ts`).

### Every email after the first must stand alone

This is the rule the sequence is built around. The person receiving a follow-up
is, by definition, the person who did not engage with the first email. Writing
"just following up" to someone who never read the original is writing to nobody:
the sentence only means something to a reader who remembers what is being
followed up on.

So every follow-up and the reactivation email carries a **one-sentence reminder**
of who is writing, tailored to the category:

- Halal Restaurants: *"I'm Owais from Aussie Venture. We create halal food content across Instagram, TikTok and Facebook."*
- Escape Rooms: *"I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook."*
- Hotels / Resorts: *"I'm Owais from Aussie Venture. We create travel and places-to-stay content across Instagram, TikTok and Facebook."*

One sentence is the ceiling, and it is enforced by the prompt. The reminder says
**who is typing**; it does not re-run the pitch, the follower count, or the
reason for emailing. A follow-up that re-argues the case reads as a marketing
sequence, and marketing sequences get archived.

### The reminder is derived, never hardcoded

`getCategoryReminderFocus()` in `src/lib/category-copy.ts` turns any category
name — including ones nobody has added yet — into the content noun. Four fallback
families cover everything:

| Family | Content noun | Reached by |
|---|---|---|
| **Food** | food content | restaurant, cafe, bakery, dessert, dining, eatery, kitchen, grill |
| **Experiences** | content featuring attractions and experiences | escape room, VR, karting, bowling, mini golf, arcade, laser tag, trampoline, climbing, theme park, aquarium, cruise, kayak |
| **Travel** | travel content | travel, tour, holiday, excursion, adventure, hotel, resort, stay, motel, apartment, lodge |
| **Lifestyle** | lifestyle content | salon, beauty, lash, nail, hair, spa, massage, wellness, barber, brow, skin — **and anything that matches nothing else** |

Narrower wording is layered on top where the family noun is true but vague:
halal categories get "halal food content", bakeries get "food and dessert
content", cafes get "food and cafe content", accommodation gets "travel and
places-to-stay content", spas get "lifestyle and wellness content".

A brand new category needs no code change. "Axe Throwing" resolves to
Experiences, "Serviced Apartments" to Travel, "Pet Grooming" to Lifestyle. A name
matching nothing at all lands on Lifestyle, which is true of Aussie Venture
whatever the business turns out to be.

### Five rules do the rest of the work

1. **Never sell twice.** The initial email is the only one that makes a case.
   Every later email gets one sentence of context and no more.
2. **State facts, don't compliment.** "You've got four rooms going at once" is an
   observation. "Your rooms look incredible" is flattery, and flattery from a
   stranger reads as the lead-up to a sales pitch.
3. **The honest reason is the best reason.** Why did this business catch our
   attention? Because we're covering this kind of business at the moment and
   theirs came up. That's true, specific, and doesn't need a paragraph.
4. **No follow-up mentions commercials.** No packages, no pricing, no budgets, no
   options, and no offering to send anything through. Follow-up 1 used to end
   "Happy to send our package options over if you want a look." It reads helpful
   and it isn't: it puts two questions in one email, so a mildly curious reader
   has to decide both before replying and answers neither. It also reframes the
   email from one person asking another a question into a supplier presenting an
   offer. Commercials are a conversation you have with someone who has already
   said yes to talking. Enforced by `NO_COMMERCIALS_RULE`.
5. **Only follow-up 3 mentions the silence.** If follow-up 2 also opens with
   "haven't heard back", the reader gets the same email twice. Follow-up 2 opens
   on "in case it was missed" instead.
6. **Everything is said in the first person, actively.** Follow-up 3 is where this
   slips: left alone the model writes "No reply has come through" or "Nothing has
   come back on this", which is the register of a system filing a report. The
   opening line is now pinned from `FU3_CLOSING_LINES`, all of which are versions
   of *"I haven't heard back, so I'll close this enquiry off at my end."*
7. **Nobody is described in the vocabulary of the list they're on.** The
   reactivation email used to say "another round of Sydney halal dining spots" —
   a scheduling word and a taxonomy label in one sentence. No restaurant owner
   thinks of themselves as a Sydney halal dining spot, and "another round"
   tells them they're an item in a batch. `getReactivationFocus()` now returns
   plain plurals of the thing itself with an ordinary location clause: "halal
   restaurants around Sydney", "things to do around Sydney", "hotels and places
   to stay around Australia".
8. **A fact about the business is one fact, said as a sentence.** Handed a
   Description and a Services list, the model tries to honour both and compresses
   them: *"you do charcoal grill with a catering side"*. Accurate, and nobody has
   ever said it out loud. `PLAIN_DETAIL_RULE` allows one fact, as an ordinary
   sentence — "You're a charcoal grill place in Lakemba." — and says to drop the
   detail entirely rather than write an awkward one.

Assumed facts below come from each lead's scraped Description/Services. The
generator is only ever allowed to use facts it was actually given.

The second paragraph of the initial email deliberately varies in shape across
these categories — some lead with the fact about the business, some lead with
what we're working on, some are a single sentence. Seventeen emails with an
identical rhythm read as a template even when every word is different. The same
applies to the reminder: it is salted per stage, so a reader who *did* see the
earlier emails gets it rephrased rather than pasted three times.

---

> **Regeneration in progress.** The rule changes above are in the code, so they
> apply to every category automatically. The reference copy below is being
> regenerated and reviewed one category at a time. **Category 1 is current.**
> Categories 2–17 are the previous copy and still show the package line in
> follow-up 1, the old follow-up 3 openers and the "another round of …" framing.
> Regenerate one with:
> `npx tsx scripts/tmp-sequence-preview.ts "<Category Name>"`

# Food

## 1. Halal Restaurants
*Nour Lebanese Kitchen, Lakemba. Sydney, visit. Fact used: charcoal grill.*
Reminder focus: **halal food content** · Reactivation focus: **halal restaurants around Sydney**

Live generation, 28 July 2026. Word counts: 61 / 44 / 43 / 42 / 66.

**Initial** — Subject: Collab with Aussie Venture?

> Hey Nour Lebanese Kitchen,
>
> I'm Owais. I run Aussie Venture, a Sydney page that posts food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> I'm covering a few halal restaurants at the moment. You're a charcoal grill place in Lakemba, so I've added you to the list.
>
> Would you be up for a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Nour Lebanese Kitchen,
>
> My email from last week might have landed in the wrong inbox.
>
> I'm Owais from Aussie Venture. We create halal food content across Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you.
>
> Would you be interested?
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Nour Lebanese Kitchen,
>
> Just sending this through in case my earlier emails got buried.
>
> I'm Owais, I run Aussie Venture. We post halal food content on Instagram, TikTok and Facebook.
>
> Would you be interested in a collab? One word back is plenty.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Nour Lebanese Kitchen,
>
> I haven't heard back, so I'll close this enquiry off at my end.
>
> I'm Owais from Aussie Venture. We make halal food content for Instagram, TikTok and Facebook.
>
> If you want to pick it up later, just reply.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Collab, take two?

> Hey Nour Lebanese Kitchen,
>
> I'm Owais from Aussie Venture. We're a Sydney page posting food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed a few months back about working together and never heard back. I'm doing more halal restaurants around Sydney over the next few months, so I thought I'd try you again.
>
> Is it worth another look now?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 2. Halal Cafes
*Zeytoun, Newtown. Sydney, visit. Fact used: open late.*
Reminder focus: **halal food content**

**Initial** — Subject: Aussie Venture x Zeytoun

> Hey Zeytoun,
>
> I'm Owais from Aussie Venture. We're a Sydney page posting food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I'm doing a few cafes over the next month and you're open late.
>
> Would you be open to a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Zeytoun,
>
> My email from last week might have landed in the wrong inbox.
>
> I'm Owais, I run Aussie Venture. We post halal food content on Instagram, TikTok and Facebook.
>
> I was asking whether you'd want to do a collab with us. We're working through a run of halal cafes around Sydney and yours is on the list.
>
> Are you interested? Happy to send our package options over if you'd like a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Zeytoun,
>
> Trying once more in case my earlier emails went unnoticed.
>
> I'm Owais from Aussie Venture. We create halal food content across Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Would you want to? Even a no is fine, I just need to know either way.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Zeytoun,
>
> Nothing back so far, so I'll wrap this one up at our end.
>
> I'm Owais from Aussie Venture. We make halal food content for Instagram, TikTok and Facebook.
>
> I'd written a couple of times about a collab. Genuinely no problem that it didn't suit.
>
> Reply any time if that changes and I'll pick it back up.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Worth another look?

> Hey Zeytoun,
>
> I'm Owais from Aussie Venture. We're a Sydney page posting food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed a few months ago about working together and never heard back. Fair enough, it was a cold email and the timing may have been off.
>
> We're lining up another round of Sydney halal dining spots now and you came up again.
>
> Would now suit better?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 3. Halal Bakeries / Dessert Shops
*Kova Patisserie, Surry Hills. Sydney, visit. Fact used: makes everything on site.*
Reminder focus: **halal food content**

**Initial** — Subject: Quick question

> Hey Kova Patisserie,
>
> I'm Owais. I run Aussie Venture, a Sydney page that posts food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> You make everything on site. We're doing more dessert places this year so I thought I'd ask.
>
> Would you be up for a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Kova Patisserie,
>
> Not sure my email last week made it through to you.
>
> I'm Owais from Aussie Venture. We create halal food content across Instagram, TikTok and Facebook.
>
> I was asking about a collab. We're covering more dessert shops and bakeries around Sydney at the moment and yours is one I wanted to include.
>
> Would you be interested? Happy to send our package options through if you want them.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Kova Patisserie,
>
> Coming back once more in case my earlier emails got lost.
>
> I'm Owais from Aussie Venture. We make halal food content for Instagram, TikTok and Facebook.
>
> I'd asked whether a collab was something you'd want to do.
>
> Is it? One word back is plenty.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Kova Patisserie,
>
> Since I haven't heard anything, I'll close this off at our end.
>
> I'm Owais, I run Aussie Venture. We post halal food content on Instagram, TikTok and Facebook.
>
> I'd emailed about doing a collab together over the past few weeks.
>
> If you'd still like to hear more, just reply and I'll pick it back up.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Collab, take two?

> Hey Kova Patisserie,
>
> I'm Owais. I run Aussie Venture, a Sydney page that posts food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed about a collab a few months back and didn't hear anything. No issue at all, plenty of these land at the wrong moment.
>
> We're planning another run of Sydney dessert and cafe spots now, so I thought I'd try you again.
>
> Is this a better time to ask?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

# Lifestyle

## 4. Nail Salons
*Luxe Nails, Melbourne CBD. Melbourne, remote.*
Reminder focus: **lifestyle content**

**Initial** — Subject: Working together?

> Hey Luxe Nails,
>
> I'm Owais, I run Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> We're doing more nail salons this year and yours came up in Melbourne.
>
> Any interest in working together?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Luxe Nails,
>
> I emailed last week but it may not have reached the right person.
>
> I'm Owais from Aussie Venture. We create lifestyle content across Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you. We're covering more nail salons around Melbourne at the moment and yours is on the list.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Luxe Nails,
>
> Checking once more in case the earlier emails were missed.
>
> I'm Owais, I run Aussie Venture. We post lifestyle content on Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Is that something you'd be interested in? A yes or no is all I need.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Luxe Nails,
>
> I'll take this off our list as there's been no reply.
>
> I'm Owais from Aussie Venture. We make lifestyle content for Instagram, TikTok and Facebook.
>
> I'd written a couple of times about a collab. No problem that it didn't land.
>
> A reply reopens it any time.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Another go at a collab?

> Hey Luxe Nails,
>
> I'm Owais, I run Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months ago and never heard back, which is completely fine. It was a cold email and the timing may not have worked.
>
> We're working through another round of Australian beauty and lifestyle venues now, so you came up again.
>
> Any better timing on your end?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 5. Hair Salons
*Edwards and Co, Paddington. Sydney, remote.*
Reminder focus: **lifestyle content**

**Initial** — Subject: Collab with Aussie Venture?

> Hey Edwards and Co,
>
> I'm Owais from Aussie Venture. We post food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I'm lining up a few hair salons over the next couple of months and yours came up.
>
> Would you be open to a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Edwards and Co,
>
> My email from last week may not have made it through to you.
>
> I'm Owais, I run Aussie Venture. We post lifestyle content on Instagram, TikTok and Facebook.
>
> I was asking whether you'd want to do a collab. We're covering more salons this year and yours is one I wanted to include.
>
> Are you interested? Happy to send our package options over if you'd like a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Edwards and Co,
>
> Trying once more in case my earlier emails got buried.
>
> I'm Owais from Aussie Venture. We create lifestyle content across Instagram, TikTok and Facebook.
>
> I'd asked about doing something together.
>
> Would you want to? Even a no is fine.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Edwards and Co,
>
> No word back, so I'll close this one off.
>
> I'm Owais from Aussie Venture. We make lifestyle content for Instagram, TikTok and Facebook.
>
> I'd emailed a couple of times about a collab. Genuinely no problem if it isn't for you.
>
> Send me a reply if you'd rather keep it open.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Aussie Venture and Edwards and Co

> Hey Edwards and Co,
>
> I'm Owais from Aussie Venture. We post food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I wrote to you about a collab a few months back and didn't hear anything. That's fair, it came out of nowhere.
>
> We're pulling together another round of Australian beauty and lifestyle venues now and you came up again.
>
> Would you be interested this time round?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 6. Beauty / Lash Studios
*Luxe Lash Studio, Bondi Junction. Sydney, remote.*
Reminder focus: **lifestyle content**

**Initial** — Subject: Quick one about a collab

> Hey Luxe Lash Studio,
>
> I'm Owais. I run Aussie Venture, we post food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> We're doing more lash and beauty studios this year, so yours came up.
>
> Would a collab be of interest?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Luxe Lash Studio,
>
> Not sure my email last week landed with you.
>
> I'm Owais from Aussie Venture. We make lifestyle content for Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you. We're working through a run of lash and beauty studios and yours is one of them.
>
> Would you be interested? Happy to send our package options through if you want them.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Luxe Lash Studio,
>
> Coming back once more in case the earlier emails were missed.
>
> I'm Owais from Aussie Venture. We create lifestyle content across Instagram, TikTok and Facebook.
>
> I'd asked whether a collab was something you'd consider.
>
> Is it? One word back is plenty.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Luxe Lash Studio,
>
> I'll leave it there since I haven't heard back.
>
> I'm Owais, I run Aussie Venture. We post lifestyle content on Instagram, TikTok and Facebook.
>
> I'd written about a collab over the last few weeks. No problem that it didn't suit.
>
> If I've got that wrong, reply and I'll pick it back up.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Better timing now?

> Hey Luxe Lash Studio,
>
> I'm Owais. I run Aussie Venture, we post food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed a few months ago about working together and never heard back. No issue, a cold email is easy to miss.
>
> We're planning another round of Australian beauty and lifestyle venues now, so I thought I'd check in with you again.
>
> Is now a better time?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 7. Spas / Massage Studios
*Endota Spa, Chatswood. Sydney, remote.*
Reminder focus: **lifestyle and wellness content**

**Initial** — Subject: Collab?

> Hey Endota Spa,
>
> I'm Owais, I run Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> We're covering more day spas this year and yours came up in Chatswood.
>
> Would you be interested in a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Endota Spa,
>
> I sent an email last week, though it may not have got to the right person.
>
> I'm Owais from Aussie Venture. We create lifestyle and wellness content across Instagram, TikTok and Facebook.
>
> I was asking about a collab. We're covering more day spas around Sydney at the moment and yours is on the list.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Endota Spa,
>
> Checking once more in case my earlier emails got buried.
>
> I'm Owais, I run Aussie Venture. We post lifestyle and wellness content on Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Is that something you'd want to do? A yes or no is all I need.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Endota Spa,
>
> I'll close the enquiry since I haven't heard from you.
>
> I'm Owais from Aussie Venture. We make lifestyle and wellness content for Instagram, TikTok and Facebook.
>
> I'd emailed a couple of times about a collab. No problem either way.
>
> If later suits better, just reply.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Worth another look?

> Hey Endota Spa,
>
> I'm Owais, I run Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months back and never heard anything. Fair enough, the timing may just have been wrong.
>
> We're putting together another round of Australian wellness and spa spots now, so you came up again.
>
> Is it worth another look now?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

# Travel

## 8. Travel Agents
*Wanderlust Travel, Parramatta. Sydney, remote. Fact used: domestic as well as overseas.*
Reminder focus: **travel content**

**Initial** — Subject: Collab with Aussie Venture?

> Hey Wanderlust Travel,
>
> I'm Owais from Aussie Venture. We post food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> We do a fair bit of travel content but not much of it with agents. You book domestic as well as overseas, so I thought I'd start with you.
>
> Would you be open to a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Wanderlust Travel,
>
> I emailed last week but it may not have reached you.
>
> I'm Owais, I run Aussie Venture. We post travel content on Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you. We're covering more travel agents this year and yours is one I wanted to get to.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Wanderlust Travel,
>
> Trying once more in case the earlier emails went unnoticed.
>
> I'm Owais from Aussie Venture. We create travel content across Instagram, TikTok and Facebook.
>
> I'd asked about doing something together.
>
> Would you want to? Even a no is fine, I just need to know.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Wanderlust Travel,
>
> No word back, so I'll close this off.
>
> I'm Owais from Aussie Venture. We make travel content for Instagram, TikTok and Facebook.
>
> I'd written a couple of times about a collab. Genuinely no problem if it isn't for you.
>
> Send me a reply if you'd like to keep it open.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Collab, take two?

> Hey Wanderlust Travel,
>
> I'm Owais from Aussie Venture. We post food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months back and never heard anything. That's fair, it arrived out of the blue.
>
> We're lining up another round of Australian travel experiences now, so you came up again.
>
> Would now suit better?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 9. Tour Operators
*Blue Mountains Guided Tours, Katoomba. Sydney, remote. Fact used: small groups.*
Reminder focus: **travel content**

**Initial** — Subject: Working together?

> Hey Blue Mountains Guided Tours,
>
> I'm Owais. I run Aussie Venture, we post food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> A lot of what we post is day trips out of Sydney, and you keep your groups small.
>
> Any interest in a collab from your end?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Blue Mountains Guided Tours,
>
> My email from last week might have gone to the wrong inbox.
>
> I'm Owais from Aussie Venture. We create travel content across Instagram, TikTok and Facebook.
>
> I was asking whether you'd want to do a collab with us. We're covering more day trips out of Sydney and yours is on the list.
>
> Are you interested? Happy to send our package options over if you'd like a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Blue Mountains Guided Tours,
>
> Coming back once more in case my earlier emails got lost.
>
> I'm Owais, I run Aussie Venture. We post travel content on Instagram, TikTok and Facebook.
>
> I'd asked whether a collab was something you'd consider.
>
> Is it? One word back is plenty.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Blue Mountains Guided Tours,
>
> I'll close the enquiry since I haven't heard from you.
>
> I'm Owais from Aussie Venture. We make travel content for Instagram, TikTok and Facebook.
>
> I'd emailed about a collab over the past few weeks. No problem that it didn't suit.
>
> If later suits better, just reply.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Another go at a collab?

> Hey Blue Mountains Guided Tours,
>
> I'm Owais. I run Aussie Venture, we post food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed a few months ago about working together and never heard back. No issue at all, these land at odd times.
>
> We're planning another round of Australian travel experiences now, so I thought I'd try you again.
>
> Is this a better time to ask?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 10. Hotels / Resorts
*Ovolo Woolloomooloo. Sydney, visit. Fact used: on the wharf.*
Reminder focus: **travel and places-to-stay content**

**Initial** — Subject: Quick question

> Hey Ovolo,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> We're doing more hotel stays this year. Yours is right on the wharf at Woolloomooloo.
>
> Would you be interested in working together on something?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Ovolo,
>
> I sent you an email last week, though it may not have got to the right person.
>
> I'm Owais from Aussie Venture. We create travel and places-to-stay content across Instagram, TikTok and Facebook.
>
> I was asking about a collab. We're covering more hotel stays this year and yours is one I'd like to get to.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Ovolo,
>
> Checking once more in case my earlier emails were missed.
>
> I'm Owais, I run Aussie Venture. We post travel and places-to-stay content on Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Is that something you'd be interested in? A yes or no is all I need.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Ovolo,
>
> I'll take this off our list as there's been no reply.
>
> I'm Owais from Aussie Venture. We make travel and places-to-stay content for Instagram, TikTok and Facebook.
>
> I'd emailed a couple of times about a collab. No problem either way.
>
> A reply reopens it any time.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Aussie Venture and Ovolo

> Hey Ovolo,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months back and never heard anything, which is completely fine. The timing may just have been wrong.
>
> We're putting together another round of Australian travel experiences and places to stay now, so you came up again.
>
> Is now a better time?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

# Experiences

## 11. Escape Rooms
*Escape Hunt, Surry Hills. Sydney, visit. Fact used: four rooms.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Collab?

> Hey Escape Hunt,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> You've got four rooms going at once. We're covering more escape rooms this year so I thought I'd ask.
>
> Would you be interested in doing something together?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Escape Hunt,
>
> I sent you an email last week, though it may not have reached you.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you. We're covering more escape rooms this year and yours is one I'd like to get to.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Escape Hunt,
>
> Checking once more in case my earlier emails got buried.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I asked a couple of weeks ago about doing a collab with you.
>
> Is that something you'd be interested in? A yes or no is all I need.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Escape Hunt,
>
> I haven't heard back, so I'll close this one off at our end.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd emailed about doing a collab over the last few weeks. No problem either way.
>
> If it's something you'd want to look at later, reply any time and I'll pick it back up.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Better timing now?

> Hey Escape Hunt,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months back and never heard anything, which is fair enough. Inboxes get busy and the timing might simply have been wrong.
>
> We're putting together another round of Sydney activities and attractions now, so you came up again.
>
> Is now a better time?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 12. VR Experiences
*Zero Latency, Darling Harbour. Sydney, visit. Fact used: free roam format.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Quick question

> Hey Zero Latency,
>
> I'm Owais from Aussie Venture. We're a Sydney page posting food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I'm putting together a few VR posts at the moment and yours is the free roam kind.
>
> Any interest in a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Zero Latency,
>
> My email from last week might have landed in the wrong inbox.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I was asking whether you'd want to do a collab with us. We're covering more VR places around Sydney and yours is on the list.
>
> Are you interested? Happy to send our package options over if you'd like a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Zero Latency,
>
> Trying once more in case my earlier emails went unnoticed.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Would you want to? Even a no is fine.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Zero Latency,
>
> I'll mark this one closed as there's been no reply.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd written a couple of times about a collab. Genuinely no problem if it isn't for you.
>
> Reply any time if that changes.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Worth another look?

> Hey Zero Latency,
>
> I'm Owais from Aussie Venture. We're a Sydney page posting food, activities and travel around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed a few months ago about working together and never heard back. Fair enough, it was a cold email and easy to miss.
>
> We're lining up another round of Sydney activities and attractions now and you came up again.
>
> Would now suit better?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 13. Go Karting
*Sydney Motorsport Karting, Eastern Creek. Sydney, visit. Fact used: outdoor track.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Aussie Venture x Sydney Motorsport Karting

> Hey Sydney Motorsport Karting,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> Go karting is something we're doing more of, and you've got the outdoor track at Eastern Creek.
>
> Would a collab be of interest?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey team,
>
> Not sure my email last week made it through.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I was asking about a collab. We're covering more karting tracks this year and yours is one I wanted to include.
>
> Would you be interested? Happy to send our package options through if you want them.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey team,
>
> Coming back once more in case the earlier emails were missed.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I'd asked whether a collab was something you'd consider.
>
> Is it? One word back is plenty.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey team,
>
> I'll take you off the list since I haven't heard anything.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd emailed about a collab over the past few weeks. No problem that it didn't suit.
>
> If it's a yes later on, send me a message.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Collab, take two?

> Hey Sydney Motorsport Karting,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed about a collab a few months back and didn't hear anything. No issue at all, plenty of these land at the wrong moment.
>
> We're planning another run of Sydney activities and attractions now, so I thought I'd try you again.
>
> Is this a better time to ask?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 14. Mini Golf
*Holey Moley, Newtown. Sydney, visit. Fact used: bar on site.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Collab with Aussie Venture?

> Hey Holey Moley,
>
> I'm Owais. I run Aussie Venture, a Sydney page that posts food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> We've got a run of mini golf coming up. You run a bar alongside the course, which is why I'm emailing.
>
> Would you be interested in working together on something?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Holey Moley,
>
> I emailed last week but it may not have reached the right person.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you. We've got a run of mini golf coming up and yours is on the list.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Holey Moley,
>
> Checking once more in case my earlier emails got buried.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I'd asked about doing something together.
>
> Is that something you'd want to do? A yes or no is all I need.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Holey Moley,
>
> No reply so far, so I'll close the enquiry.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd written a couple of times about a collab. No problem either way.
>
> Happy to reopen it if you reply.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Another go at a collab?

> Hey Holey Moley,
>
> I'm Owais. I run Aussie Venture, a Sydney page that posts food, activities and travel from around the country, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed a few months ago about working together and never heard back. No issue, a cold email is easy to miss.
>
> We're working through another round of Sydney activities and attractions now, so you came up again.
>
> Any better timing on your end?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 15. Bowling
*Kingpin, Macquarie Park. Sydney, visit. Fact used: laser tag and karaoke on site.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Working together?

> Hey Kingpin,
>
> I'm Owais from Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> You've got laser tag and karaoke on site as well as the lanes. I've been lining up bowling spots for the next couple of months.
>
> Any interest in working together?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Kingpin,
>
> My email from last week may not have made it through to you.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I was asking whether you'd want to do a collab. I've been lining up bowling spots for the next couple of months and yours is one of them.
>
> Are you interested? Happy to send our package options over if you'd like a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Kingpin,
>
> Trying once more in case the earlier emails went unnoticed.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Would you want to? Even a no is fine, I just need to know.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Kingpin,
>
> I'll leave it there since I haven't heard back.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd emailed about a collab over the last few weeks. Genuinely no problem if it isn't for you.
>
> If you'd like to hear more, just reply.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Aussie Venture and Kingpin

> Hey Kingpin,
>
> I'm Owais from Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I wrote to you about a collab a few months back and didn't hear anything. That's fair, it came out of nowhere.
>
> We're pulling together another round of Sydney activities and attractions now and you came up again.
>
> Would you be interested this time round?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 16. Trampoline Parks
*Flip Out, Prestons. Sydney, visit. Fact used: toddler sessions.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Quick one about a collab

> Hey Flip Out,
>
> I'm Owais, I run Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> We do a lot of school holiday content and I'm sorting the next round out now. You do toddler sessions during the week.
>
> Would you be up for a collab?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey Flip Out,
>
> Not sure if my last email reached the right inbox.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I was asking about a collab. We're sorting the next round of school holiday content now and yours is one of the places on the list.
>
> Would you be interested? Happy to send our package options through if you want them.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey Flip Out,
>
> Coming back once more in case my earlier emails got lost.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I'd asked whether a collab was something you'd consider.
>
> Is it? One word back is plenty.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey Flip Out,
>
> I'll assume it's not for you and close it off.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd emailed a couple of times about a collab. No problem at all either way.
>
> If I've got that wrong, reply and I'll pick it back up.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Better timing now?

> Hey Flip Out,
>
> I'm Owais, I run Aussie Venture. We post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months back and never heard anything, which is completely fine. The timing may just have been wrong.
>
> We're planning another round of Sydney activities and attractions now, so you came up again.
>
> Is now a better time?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## 17. Cruises
*Captain Cook Cruises, Circular Quay. Sydney, visit. Fact used: lunch and dinner sailings.*
Reminder focus: **content featuring attractions and experiences**

**Initial** — Subject: Aussie Venture x Captain Cook Cruises

> Hey Captain Cook Cruises,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> You run lunch and dinner sailings, not just sightseeing. We're doing more on the harbour over summer.
>
> Would you be interested in doing something with us?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

**Follow-up 1** (day 7)

> Hey team,
>
> I sent an email last week, though it may not have got seen at your end.
>
> I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.
>
> I was asking about doing a collab with you. We're doing more on the harbour over summer and yours is one I'd like to get to.
>
> Would you be interested? Happy to send our package options over if you want a look.
>
> Cheers,
> Owais

**Follow-up 2** (day 14)

> Hey team,
>
> Checking once more in case my earlier emails were missed.
>
> I'm Owais, I run Aussie Venture. We post content featuring attractions and experiences on Instagram, TikTok and Facebook.
>
> I'd asked about doing something together with you.
>
> Is that something you'd be interested in? A yes or no is all I need.
>
> Cheers,
> Owais

**Follow-up 3** (day 21)

> Hey team,
>
> I'll wrap this one up at our end since there's been no reply.
>
> I'm Owais from Aussie Venture. We make content featuring attractions and experiences for Instagram, TikTok and Facebook.
>
> I'd emailed about a collab over the past few weeks. No problem either way.
>
> If it's worth another look down the line, just reply.
>
> Cheers,
> Owais

**Reactivation** (day 90+) — Subject: Worth another look?

> Hey Captain Cook Cruises,
>
> I'm Owais, I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia, around 650k followers across Instagram, TikTok and Facebook.
>
> I emailed you about a collab a few months back and never heard anything. Fair enough, the timing may just have been wrong.
>
> We're putting together another round of Sydney activities and attractions now, so you came up again.
>
> Is it worth another look now?
>
> Cheers,
> Owais
> Aussie Venture
> aussieventure.com
> instagram.com/aussie.venture

---

## What was cut, and why

Findings from reviewing the drafts of the above. Each was a real pattern that
made the set read as generated rather than typed.

**"Just following up."** Cut from the whole sequence, and now banned in the
prompt. It is only meaningful to a reader who remembers the first email, which is
the one reader who is definitionally not receiving a follow-up. Every follow-up
now opens on the possibility that the earlier email was never seen, then says who
is writing.

**Follow-up 2 used to ask about packages.** It was the shortest email in the
sequence and its whole job was "want me to send the options through". That is two
decisions in one email: do I want a collab, and do I want a document. It now asks
one thing, whether they're interested, and makes a one-word answer explicitly
acceptable. No packages, no pricing, no budgets.

**So did follow-up 1, and that was the last of it.** The commercials ban was
originally written for follow-up 2 only, so follow-up 1 kept ending "Happy to send
our package options over if you want a look." Same defect, one email earlier: two
decisions in one email, and the frame shifts from a person asking a question to a
supplier presenting an offer. The ban is now a shared rule
(`NO_COMMERCIALS_RULE`) applied to all three follow-ups and the reactivation, and
it covers offering to *send* anything as well as naming a price. Nothing in the
sequence after email one mentions money or deliverables.

**Follow-up 3 reported the silence instead of mentioning it.** "No reply has come
through" reads as a system logging a missed SLA, not a person who checked their
inbox and decided to stop waiting. The line is now pinned from
`FU3_CLOSING_LINES`, in the first person and active: *"I haven't heard back, so
I'll close this enquiry off at my end."* The passive versions are banned by name,
because they are what the model reaches for unprompted.

**The reactivation email described people as taxonomy.** "We're putting together
another round of Sydney halal dining spots now." Two internal words in one
sentence: "another round" is scheduling, and "Sydney halal dining spots" is a
category label. Both leaked in because the same string was convenient as a
variable name and as prose. `getReactivationFocus()` now returns what a person
would say on the phone — "halal restaurants around Sydney" — and it lands in a
sentence a person would write.

**"You do charcoal grill with a catering side."** A live generation produced this,
from a Description and a Services list the model was trying to honour at once.
Every word accurate; nobody has said it out loud. `PLAIN_DETAIL_RULE` now allows
one fact as an ordinary sentence, forbids joining two with "with a … side"/"plus"/
"as well as", forbids verbing a noun to save words, and says to drop the detail
entirely rather than write an odd sentence.

**The reactivation email pretended it was a cold email.** The old prompt banned
every reference to prior contact, so a business we had emailed four times got a
"we've never spoken" opener 90 days later. That is a lie the recipient can check
in two clicks. It now owns the earlier attempt in one clause, with no apology and
no guilt, and asks the only genuinely new question available: whether the timing
is better now.

**The reactivation sign-off was eight lines.** hello@aussieventure.com, the
website and five social links. It now uses the same two-link sign-off as the
initial email, for the same reason: a long link block reads as a marketing
footer and undoes the work the body just did.

**"so you're on my list" in nine of twelve.** The list metaphor is a good honest
reason, which is exactly why it became a crutch. Now used twice.

**Every initial email had the same two-sentence rhythm.** Reason, then fact, then
a "so I..." connector. Individually fine, as a set it was the clearest template
tell in the batch. Now the shape rotates across four variants.

**All twelve follow-up 2s and 3s opened by mentioning the silence.** Two emails
in a row opening "haven't heard back" is the reader's cue that a tool is sending
them. Follow-up 3 keeps the line because closing the loop is its job. Follow-up 2
opens on "in case it was missed" instead.

**Seven of twelve follow-up 2s had a trailing justification clause.** "Then
you've got something to say yes or no to", "easier to make a call with them in
front of you". Every one was a copywriter explaining the tactic inside the email.
All cut.

**"In the nail salon space."** A live generation produced this. "Space" as an
industry word is now banned outright — nobody who runs a nail salon calls it that.

## Judgement calls worth knowing about

**The word bands were lowered rather than the emails lengthened.** This was
measured, not assumed. Written by hand to the exact structure asked for —
missed-email framing, reminder, what I asked, easy ask — the copy lands at 40–70
words. The first pass set the bands slightly above that (FU1 70–100, FU2 50–75,
FU3 60–85) on the theory that a floor keeps the emails substantial. It does the
opposite. The model writes a good short email, counts it against the floor, and
fills the gap with the only material it has left: a line about why replying helps
them, or their own business described back to them. Both are banned everywhere
else in the voice rules, so the floors were reintroducing them through the back
door.

The bands are now FU1 45–80, FU2 40–65, FU3 40–70, reactivation 65–100, with
`LENGTH_RULE` stating in the prompt that going under is fine and padding to a
count is not. The initial email keeps its 75-word ceiling and has "there is no
minimum" added. Optimising for readability and reply rate means the shortest email
that does the job wins, every time.

If the longer versions are ever wanted, the bands are one line each in
`stageGuidance` in `src/ai/workflows.ts` and one line in
`buildReactivationEmailPrompt`. Nothing else needs to change.

**The reminder repeats down the thread.** A reader who *did* see email one gets
told who we are three more times. That is the deliberate trade: the cost is mild
redundancy for an engaged reader, and the benefit is that a cold reader can
actually act on any email in the sequence. It is salted per stage so the wording
rotates rather than pastes.

**The word "collab" is used in about half the asks.** It is arguably influencer
language. It is also the word this industry actually uses, and the alternatives
("a content partnership") are worse. If it should go entirely, that's a one-line
change to `INITIAL_ASKS` in `src/lib/email-voice.ts`.

**The follower count appears once, in the initial email and the reactivation
email.** Both are re-introductions to someone who does not know us. The
follow-ups name the platforms in the reminder but never the number: platforms say
what we are, a follower count is a pitch.

**Follow-up 3 says the enquiry is being closed.** That is real: after FU3 the
lead is marked dead. Saying so is more respectful than a vague "door's always
open", and it gives a reason to reply now without manufacturing urgency.

**"Ramen Bars" would classify as Lifestyle, not Food.** The keyword list in
`category-copy.ts` covers restaurant/cafe/bakery/dessert/food/dining/eatery/
kitchen/grill, so a cuisine-named category with none of those words falls to the
Lifestyle default. That is safe rather than wrong — "we create lifestyle content"
is true of Aussie Venture regardless — but if categories like that get added,
adding the keyword is a one-line change.
