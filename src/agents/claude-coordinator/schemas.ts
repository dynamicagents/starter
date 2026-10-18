/**
 * What a session must answer, by name: the JSON schemas the image's daemon is
 * built with, which a run names in its header.
 *
 * A module with no imports, because the daemon is bundled from it for Node
 * (`src/sandbox-daemon.ts`) and must carry nothing of the Worker.
 */

/**
 * What a planning session must answer, as `--json-schema`. The descriptions are
 * the session's instructions for each field — the CLI puts them in front of the
 * model as the `StructuredOutput` tool's schema.
 */
export const PLAN_OUTPUT = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "A short name for the plan, a few words. Its page is headed by it."
    },
    plan: {
      type: "string",
      description:
        "The plan, in Markdown, for the person who approves it: what will change and where, what stays as it is, and how the result will be checked. Complete on its own — the session that carries it out usually continues this conversation, but may start without it and have only this. What you established about the base goes in it as fact, so that session compares against it instead of finding it out again. Where a real choice existed — another shape, another place for the change, a smaller change that solves most of it — the plan says what you weighed and what decided it, with the cost on each side — the person's answer, where the choice was theirs. Where the request named an approach and another is better, say so and why, and say what following the request would mean. Where there was only one sensible way, write nothing about alternatives: a section that lists none is noise in what the person reads. Never an open-questions section: what is open goes in `questions`. Name no branch: that session is given one, and it is the pull request's head."
    },
    lastReply: {
      type: "string",
      description:
        "What you tell the agent that asked for the plan, which does not read the plan itself: what it does in two or three sentences, the assumptions you made, and what you could not check. A question for the person goes in `questions`, never here."
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question, standing on its own: the person answers it without the plan in front of them, so say what is being decided and why it matters."
          },
          options: {
            type: "array",
            // `MAX_ASK_OPTIONS`, from `@dynamicagents/core/agent`: the agent
            // asks these as they stand.
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description:
                    'What they pick, in a few words. The one you recommend comes first, its label ending "(Recommended)".'
                },
                description: {
                  type: "string",
                  description: "What picking it means, and what it costs."
                },
                example: {
                  type: "string",
                  description:
                    "A concrete sample of what picking it produces — a snippet, a shape — in Markdown, when seeing it helps them choose."
                }
              },
              required: ["label"],
              additionalProperties: false
            },
            description:
              "The answers to pick from, when there are a few — for a choice, the ways in you weighed. Leave it out to have them type an answer."
          }
        },
        required: ["question"],
        additionalProperties: false
      },
      description:
        "What only the person can settle: every real choice they have not made — which of the ways in you weighed they prefer, a better approach than the one the request named — and every trade-off only they can rank or constraint you suspect but cannot read. You cannot stop to ask mid-run, so this is how a question reaches them. While any is open the plan is a draft: they answer these first, you revise with their answers, and only a version that comes back with none is put to them to approve. Leave it out when nothing is open."
    }
  },
  required: ["title", "plan", "lastReply"],
  additionalProperties: false
} as const;

/**
 * What a writing session must answer, as `--json-schema`, so the coordinator
 * reads fields rather than prose. The descriptions are the session's
 * instructions for each one.
 */
export const WRITE_OUTPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["done", "needs_input", "blocked"],
      description:
        "`done`: the work is finished, or there was nothing to change. `needs_input`: you stopped on a question for the person — a decision only they can make, or a deviation of design, shape or scope that is theirs to approve. `blocked`: you could not finish, and `summary` says where you stopped and why."
    },
    summary: {
      type: "string",
      description:
        "For the agent that briefed you, which relays it to the person: what you changed and why, or what you found. On a pull request, say whether you answered its review and how its checks stand. Say where you departed from the brief or the plan, including what you judged too small to stop for. Plain and short."
    },
    pullRequests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          url: { type: "string" }
        },
        required: ["number", "url"],
        additionalProperties: false
      },
      description:
        "Every pull request you opened or pushed to, one per repository the work changed. Leave it out when you pushed nothing."
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          passed: { type: "boolean" }
        },
        required: ["command", "passed"],
        additionalProperties: false
      },
      description:
        "What you ran to check the work, each with whether it passed. Only what you ran."
    },
    question: {
      type: "string",
      description:
        "Required with `needs_input`: the one question for the person, with the options you see. For a deviation, say what you were going to do, what you would do instead, and what each costs."
    }
  },
  required: ["status", "summary"],
  additionalProperties: false
} as const;

/** Each schema by the name a run's header gives it. */
export const SESSION_SCHEMAS = {
  plan: PLAN_OUTPUT,
  write: WRITE_OUTPUT
} as const;

export type SessionSchema = keyof typeof SESSION_SCHEMAS;
