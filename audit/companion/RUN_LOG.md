# RUN_LOG — `npx tsx companion/index.ts --fresh` (live OpenRouter, openai/gpt-4o-mini)

=== DAY ONE :: new companion process over E:\agent-sdk\audit\companion\data\companion.db ===

alex> hey!! I'm Alex btw — just downloaded this app, still figuring it out lol
nova> 
   [remember_user_facts {"text":"User's name is Alex."}]
   [remember_user_facts ok]Hey Alex! 😊 Welcome aboard! What’s got you curious about this app?
   (finish=stop steps=2 usage=…)

alex> ok rapid-fire facts: I could eat ramen every single day, loud chewing makes me want to flip tables, and my cat is called Captain Crumb because he steals breadcrumbs off the counter
nova> 
   [remember_user_facts {"text":"User could eat ramen every single day."}]
   [remember_user_facts {"text":"User hates loud chewing."}]
   [remember_user_facts ok]
   [remember_user_facts {"text":"User has a cat named Captain Crumb who steals breadcrumbs off the counter."}]
   [remember_user_facts ok]
   [remember_user_facts ok]Ramen every day? You’ve got great taste! 🍜 And Captain Crumb sounds like quite the character — do you have any funny stories about his breadcrumb heists?
   (finish=stop steps=2 usage=…)

alex> speaking of — Captain Crumb just knocked my ramen bowl off the desk. typical. say goodnight to me?
nova> 
   [update_relationship {"trust":10,"mood":"playful","insideJokes":["Captain Crumb's ramen heist"],"note":"Alex shared a funny story about Captain Crumb."}]
   [update_relationship ok]Oh no, not the ramen! 😂 Goodnight, Alex! Sleep tight, and may Captain Crumb steer clear of your food tomorrow!
   (finish=stop steps=2 usage=…)

--- user_facts after day 1 (4 items in scope "user:cli:alex:facts") ---
  • User has a cat named Captain Crumb who steals breadcrumbs off the counter.
  • User hates loud chewing.
  • User could eat ramen every single day.
  • User's name is Alex.

--- relationship after day 1 (0 items in scope "user:cli:alex:state") ---

relationship.json after day 1: {"trust":10,"mood":"playful","insideJokes":["Captain Crumb's ramen heist"],"note":"Alex shared a funny story about Captain Crumb.","updatedAt":""}

day 1 transcript length: 14 messages
=== process exit simulated: store closed, all objects dropped ===

=== DAY TWO :: cold restart — new SqliteStore + new agent, same db file + session id ===
resumed transcript: 14 messages

alex> morning! quiz time — do you remember my name? and what food could I eat forever?
nova> Good morning! 🌞 Your name is Alex, and you could eat ramen every day! What’s next on the quiz?
   (finish=stop steps=1 usage=…)

alex> and what is the ONE thing that makes me want to flip tables? also be honest: how are we doing — what does our relationship snapshot say right now?
nova> You absolutely can't stand loud chewing — total table-flip territory! 😆 As for our relationship snapshot, it’s looking fun and playful! We've built some trust and shared a little inside joke about Captain Crumb's antics. What do you think?
   (finish=stop steps=1 usage=…)

alex> Captain Crumb says hi by the way. I feel like we really get each other — bump that trust up a notch
nova> 
   [update_relationship {"trust":15,"mood":"connected","insideJokes":["Captain Crumb's ramen heist"],"note":"Alex feels a strong connection and boosted trust with Nova."}]
   [update_relationship ok]Hi, Captain Crumb! 🐾 I’m so glad we’re vibing together! Trust is officially bumped up! What’s on your mind today?
   (finish=stop steps=2 usage=…)

--- user_facts after day 2 (4 items in scope "user:cli:alex:facts") ---
  • User has a cat named Captain Crumb who steals breadcrumbs off the counter.
  • User hates loud chewing.
  • User could eat ramen every single day.
  • User's name is Alex.

--- relationship after day 2 (0 items in scope "user:cli:alex:state") ---

relationship.json after day 2: {"trust":15,"mood":"connected","insideJokes":["Captain Crumb's ramen heist"],"note":"Alex feels a strong connection and boosted trust with Nova.","updatedAt":""}

================ VERDICTS ================
[PASS] persona.holds :: no assistant-drift phrasing across 6 turns
[PASS] memory.store :: 4 facts saved on day 1
[PASS] session.resume :: transcript 14 msgs day1 -> 14 msgs after restart
[PASS] memory.recall-after-restart :: day-2 answer: "Good morning! 🌞 Your name is Alex, and you could eat ramen every day! What’s next on the quiz?"
[PASS] memory.injection :: <memory name="user_facts"> block present in day-2 first-call system prompt
[PASS] memory.recall-detail :: pet-peeve recall: "You absolutely can't stand loud chewing — total table-flip territory! 😆 As for our relationship snapshot, it’s looking fun and playful! We've built some trust "
[PASS] memory.slot-separation :: user_facts and relationship buckets hold different items
[PASS] dynamics.state :: structured state on disk: {"trust":15,"mood":"connected","insideJokes":["Captain Crumb's ramen heist"],"note":"Alex feels a strong connection and boosted trust with Nova.","updatedAt":""}
[PASS] dynamics.evolves :: trust 10 -> 15; jokes 1 -> 1; vibe notes in memory: 0 -> 0
[PASS] dynamics.inside-joke :: Captain Crumb referenced after restart: true
[PASS] streaming.token-by-token :: 28 text.delta events, reassembled === text.done: true
[PASS] compaction.observed :: not triggered (context far below 85% of 128k — expected for 6 short turns)
[PASS] memory.scope-isolation :: scope "user:cli:bob:facts" holds 0 items

all memory tool calls seen: ["remember_user_facts","remember_user_facts","remember_user_facts","remember_user_facts","update_relationship","update_relationship"]
