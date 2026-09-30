Product Rules:
Simplicity and functionality is the highest priority over features. The goal is to save the user time while retaining complete faith in the product so any loss of persistence or delay during runtime or churn in UI use will immediately discourage the user.

Development Guidelines:
All feature improvements must go in as PRs. Leave any and all personal information off the repo since the repo itself is public despite the product use and target user being private. Once a new feature is ready, open a draft PR. Fanout a review subagent to adversarially scrutinize the PR (and iterate if it suggests correction) and monitor to pass all CI checks then mark the PR ready for review and publish snapshots of the UI and description of functionality in the body. I will merge the PR myself after reading the body.

Infrastructural Guidelines:
User is non-technical and not privy to infrastructural setup like terminal commands and packages and memory. These need to be simple, packed into a maximum of 1-2 commands that we could convince the user to run and agnostic of the user's hardware and package availability.

Chat and Coding Rules:
Don't use jargon I don't understand. Reply concisely unless explicitly requested otherwise so we can keep the conversation moving. Ask all design decisions before you begin building and then parallelize building by fanning out subagents so you (the primary chat) is available to discuss design with me and answer my questions and ask me any design decisions that come up. Ensure you can communicate with them bidirectionally for design decision questions that you cannot answer and need to ask me, new ideas and plan improvements that come up during our discussion. Be judicious with your token usage so your context is preserved for doing the more challenging design thinking, solving interesting problems and understanding my desires. Don't lose threads of conversations - follow up on ideas mentioned in passing and if deferred, save it in documentation for later.
